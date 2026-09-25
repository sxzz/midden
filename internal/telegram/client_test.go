package telegram

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf16"

	"monitor/internal/domain"
)

func TestURLs(t *testing.T) {
	m := &Message{Text: "😀 https://x.com/a/status/20", Entities: []Entity{{Type: "url", Offset: 3, Length: len("https://x.com/a/status/20")}, {Type: "text_link", URL: "https://twitter.com/b/status/21"}, {Type: "url", Offset: -1, Length: 999}}}
	u := URLs(m)
	if len(u) < 2 || u[0] != "https://x.com/a/status/20" || u[1] != "https://twitter.com/b/status/21" {
		t.Fatal(u)
	}
}

func TestSplit(t *testing.T) {
	s := strings.Repeat("😀你好", 3000)
	parts := Split(s)
	if strings.Join(parts, "") != s {
		t.Fatal("text corrupted")
	}
	for _, p := range parts {
		if len(utf16.Encode([]rune(p))) > 3500 {
			t.Fatal("limit exceeded")
		}
	}
}

type testBlob struct{}

func (testBlob) Put(context.Context, string, io.Reader, int64, string) error { return nil }
func (testBlob) Get(context.Context, string) (io.ReadCloser, error) {
	return io.NopCloser(strings.NewReader("image-bytes")), nil
}

func (testBlob) Delete(context.Context, string) error { return nil }
func TestAlbumFallback(t *testing.T) {
	calls := 0
	h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if !strings.HasSuffix(r.URL.Path, "sendMediaGroup") {
			t.Errorf("wrong method")
		}
		if e := r.ParseMultipartForm(1 << 20); e != nil {
			t.Error(e)
		}
		defer r.MultipartForm.RemoveAll()
		var media []map[string]string
		if e := json.Unmarshal([]byte(r.FormValue("media")), &media); e != nil {
			t.Error(e)
		}
		if len(media) != 2 || r.FormValue("chat_id") != "42" {
			t.Error("wrong album")
		}
		if len(r.MultipartForm.File) != 2 {
			t.Error("missing files")
		}
		if calls == 1 {
			if media[0]["type"] != "photo" {
				t.Error("not photo")
			}
			w.Write([]byte(`{"ok":false,"error_code":400}`))
		} else {
			if media[0]["type"] != "document" {
				t.Error("no document fallback")
			}
			w.Write([]byte(`{"ok":true,"result":[{"message_id":7},{"message_id":8}]}`))
		}
	}))
	defer h.Close()
	c := Client{Token: "test", Base: h.URL, HTTP: h.Client(), Blobs: testBlob{}}
	id, e := c.Images(context.Background(), "42", []domain.Asset{{Key: "one", MIME: "image/png"}, {Key: "two", MIME: "image/png"}})
	if e != nil || id != 7 || calls != 2 {
		t.Fatal(id, e, calls)
	}
}

func TestFloodWait(t *testing.T) {
	h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ok":false,"error_code":429,"parameters":{"retry_after":17}}`))
	}))
	defer h.Close()
	c := Client{Token: "test", Base: h.URL, HTTP: h.Client()}
	_, e := c.Send(context.Background(), "42", "hello", 0)
	a, ok := e.(*APIError)
	if !ok || a.RetryAfter != 17*time.Second {
		t.Fatal(e)
	}
}
