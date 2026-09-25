package telegram

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"monitor/internal/domain"
)

type memoryCache map[string]string

func (m memoryCache) GetChannelMedia(_ context.Context, c, a, h, r string) (string, error) {
	return m[c+":"+a+":"+h+":"+r], nil
}

func (m memoryCache) PutChannelMedia(_ context.Context, c, a, h, r, id string) error {
	m[c+":"+a+":"+h+":"+r] = id
	return nil
}

func (m memoryCache) DeleteChannelMedia(_ context.Context, c, a, h, r, id string) error {
	k := c + ":" + a + ":" + h + ":" + r
	if m[k] == id {
		delete(m, k)
	}
	return nil
}

type countedBlob struct {
	testBlob
	reads int
}

func (b *countedBlob) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	b.reads++
	return b.testBlob.Get(ctx, key)
}

func TestFileCacheReuseAndInvalidation(t *testing.T) {
	for _, tc := range []struct{ mime, kind, response string }{
		{"video/mp4", "video", `"video":{"file_id":"remote"}`},
		{"image/png", "photo", `"photo":[{"file_id":"small","width":1,"height":1},{"file_id":"remote","width":100,"height":100}]`},
		{"video/webm", "document", `"document":{"file_id":"remote"}`},
	} {
		t.Run(tc.kind, func(t *testing.T) {
			ctx := context.Background()
			cache := memoryCache{}
			blobs := &countedBlob{}
			calls := 0
			reject := false
			rateLimit := false
			h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				uploaded := strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/")
				if uploaded {
					if err := r.ParseMultipartForm(1 << 20); err != nil {
						t.Error(err)
					}
					defer r.MultipartForm.RemoveAll()
				} else {
					r.ParseForm()
					if r.Form.Get(tc.kind) != "remote" {
						t.Error("wrong cached reference", r.Form)
					}
				}
				if r.FormValue("caption") != "archive" || r.FormValue("reply_to_message_id") != "12" {
					t.Error("lost caption/reply")
				}
				if tc.kind != "document" && r.FormValue("has_spoiler") != "true" {
					t.Error("spoiler lost on upload/cache hit")
				}
				if rateLimit {
					fmt.Fprint(w, `{"ok":false,"error_code":429,"parameters":{"retry_after":10}}`)
					return
				}
				if reject && !uploaded {
					reject = false
					fmt.Fprint(w, `{"ok":false,"error_code":400,"description":"Bad Request: wrong file identifier/HTTP URL specified"}`)
					return
				}
				fmt.Fprintf(w, `{"ok":true,"result":{"message_id":7,%s}}`, tc.response)
			}))
			defer h.Close()
			send := func(bot string) {
				t.Helper()
				c := Client{Token: "test", BotID: bot, Cache: cache, Blobs: blobs, HTTP: h.Client(), Base: h.URL}
				_, err := c.WithReplyTo(12).Media(ctx, "-42", []domain.Asset{{Key: "object", Hash: "hash", MIME: tc.mime, Sensitive: tc.kind != "document"}}, "archive")
				if err != nil {
					t.Fatal(err)
				}
			}
			send("bot1")
			send("bot1")
			if blobs.reads != 1 || calls != 2 {
				t.Fatal("repeat send reuploaded", blobs.reads, calls)
			}
			reject = true
			send("bot1")
			if blobs.reads != 2 || calls != 4 {
				t.Fatal("invalid reference not replaced", blobs.reads, calls)
			}
			send("bot2")
			if blobs.reads != 3 {
				t.Fatal("cross-bot cache reused")
			}
			rateLimit = true
			c := Client{Token: "test", BotID: "bot1", Cache: cache, Blobs: blobs, HTTP: h.Client(), Base: h.URL}
			_, err := c.WithReplyTo(12).Media(ctx, "-42", []domain.Asset{{Key: "object", Hash: "hash", MIME: tc.mime, Sensitive: tc.kind != "document"}}, "archive")
			if err == nil || blobs.reads != 3 || cache["telegram:bot1:hash:"+tc.kind] != "remote" {
				t.Fatal("transient error invalidated cache")
			}
		})
	}
}

func TestAlbumCachedAndUploadedMedia(t *testing.T) {
	cache := memoryCache{"telegram:bot:video:video": "video-file"}
	blobs := &countedBlob{}
	calls := 0
	h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/") {
			r.ParseMultipartForm(1 << 20)
			defer r.MultipartForm.RemoveAll()
			if len(r.MultipartForm.File) != 1 {
				t.Error("cached video uploaded")
			}
		} else {
			r.ParseForm()
		}
		var media []map[string]any
		if err := json.Unmarshal([]byte(r.FormValue("media")), &media); err != nil {
			t.Error(err)
		}
		if len(media) != 2 || media[0]["media"] != "video-file" || media[0]["caption"] != "caption" || media[0]["has_spoiler"] != true || media[1]["has_spoiler"] != nil {
			t.Error(media)
		}
		if calls == 2 && media[1]["media"] != "photo-file" {
			t.Error("album photo not reused")
		}
		fmt.Fprint(w, `{"ok":true,"result":[{"message_id":1,"video":{"file_id":"video-file"}},{"message_id":2,"photo":[{"file_id":"photo-file","width":50,"height":50}]}]}`)
	}))
	defer h.Close()
	for i := 0; i < 2; i++ {
		c := Client{BotID: "bot", Token: "test", Cache: cache, Blobs: blobs, Base: h.URL, HTTP: h.Client()}
		_, err := c.Media(context.Background(), "42", []domain.Asset{{Hash: "video", MIME: "video/mp4", Sensitive: true}, {Hash: "photo", MIME: "image/png"}}, "caption")
		if err != nil {
			t.Fatal(err)
		}
	}
	if blobs.reads != 1 {
		t.Fatal(blobs.reads)
	}
}

func TestSensitiveDocumentFallback(t *testing.T) {
	calls := 0
	h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			t.Error(err)
		}
		defer r.MultipartForm.RemoveAll()
		if strings.HasSuffix(r.URL.Path, "sendPhoto") {
			if r.FormValue("has_spoiler") != "true" {
				t.Error("photo has no spoiler")
			}
			fmt.Fprint(w, `{"ok":false,"error_code":400,"description":"unsupported photo"}`)
		} else {
			if !strings.HasSuffix(r.URL.Path, "sendDocument") || r.FormValue("has_spoiler") != "" {
				t.Error("invalid document fallback")
			}
			fmt.Fprint(w, `{"ok":true,"result":{"message_id":7,"document":{"file_id":"file"}}}`)
		}
	}))
	defer h.Close()
	c := Client{Token: "test", Base: h.URL, HTTP: h.Client(), Blobs: testBlob{}}
	id, err := c.Media(context.Background(), "42", []domain.Asset{{MIME: "image/png", Sensitive: true}}, "")
	if err != nil || id != 7 || calls != 2 {
		t.Fatal(id, err, calls)
	}
}
