package telegram

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
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

//go:embed testdata/landscape.mp4
var testVideo []byte

type testBlob struct{}

func (testBlob) Put(context.Context, string, io.Reader, int64, string) error { return nil }
func (testBlob) Get(context.Context, string) (io.ReadCloser, error) {
	return io.NopCloser(bytes.NewReader(testVideo)), nil
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
		var media []map[string]any
		if e := json.Unmarshal([]byte(r.FormValue("media")), &media); e != nil {
			t.Error(e)
		}
		if len(media) != 2 || r.FormValue("chat_id") != "-42" || r.FormValue("reply_to_message_id") != "123" {
			t.Error("wrong album")
		}
		if media[0]["caption"] != "collection-id\n正文" || media[1]["caption"] != nil || media[0]["caption_entities"] == nil {
			t.Error("caption or code entity lost", media)
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
	id, e := c.WithReplyTo(123).WithCode("collection-id").Media(context.Background(), "-42", []domain.Asset{{Key: "one", MIME: "image/png"}, {Key: "two", MIME: "image/png"}}, "collection-id\n正文")
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

func TestEditUnchangedDoesNotSendDuplicate(t *testing.T) {
	calls := 0
	h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if !strings.HasSuffix(r.URL.Path, "editMessageText") {
			t.Errorf("unexpected method: %s", r.URL.Path)
		}
		if err := r.ParseForm(); err != nil {
			t.Error(err)
		}
		if r.Form.Get("message_id") != "12" || !strings.Contains(r.Form.Get("reply_markup"), "/list") {
			t.Error("missing edit or keyboard")
		}
		w.Write([]byte(`{"ok":false,"error_code":400,"description":"Bad Request: message is not modified"}`))
	}))
	defer h.Close()
	c := Client{Token: "test", Base: h.URL, HTTP: h.Client()}
	id, err := c.SendInteractive(context.Background(), "42", "done", 12, Keyboard{{{Text: "收藏列表", Data: "/list"}}})
	if err != nil || id != 12 || calls != 1 {
		t.Fatal(id, err, calls)
	}
}

func TestEmptyKeyboardUsesArray(t *testing.T) {
	for _, previous := range []int64{0, 12} {
		t.Run(fmt.Sprint(previous), func(t *testing.T) {
			h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if err := r.ParseForm(); err != nil {
					t.Error(err)
				}
				var markup map[string]json.RawMessage
				if err := json.Unmarshal([]byte(r.Form.Get("reply_markup")), &markup); err != nil {
					t.Error(err)
				}
				if string(markup["inline_keyboard"]) != "[]" {
					t.Errorf("empty keyboard must be an array: %s", r.Form.Get("reply_markup"))
					w.WriteHeader(http.StatusBadRequest)
					w.Write([]byte(`{"ok":false,"error_code":400,"description":"invalid keyboard"}`))
					return
				}
				w.Write([]byte(`{"ok":true,"result":{"message_id":12}}`))
			}))
			defer h.Close()
			c := Client{Token: "test", Base: h.URL, HTTP: h.Client()}
			if _, err := c.SendInteractive(context.Background(), "42", "暂无收藏。", previous, nil); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestCallbackActorAndPolling(t *testing.T) {
	h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		switch {
		case strings.HasSuffix(r.URL.Path, "getUpdates"):
			if r.Form.Get("offset") != "123" || !strings.Contains(r.Form.Get("allowed_updates"), "callback_query") {
				t.Error("polling configuration")
			}
			w.Write([]byte(`{"ok":true,"result":[{"update_id":123,"callback_query":{"id":"cb","from":{"id":42},"message":{"message_id":7,"from":{"id":999,"is_bot":true},"chat":{"id":42,"type":"private"}},"data":"/list"}}]}`))
		case strings.HasSuffix(r.URL.Path, "answerCallbackQuery"):
			if r.Form.Get("callback_query_id") != "cb" {
				t.Error("callback id")
			}
			w.Write([]byte(`{"ok":true,"result":true}`))
		case strings.HasSuffix(r.URL.Path, "sendChatAction"):
			if r.Form.Get("action") != "typing" {
				t.Error("action")
			}
			w.Write([]byte(`{"ok":true,"result":true}`))
		default:
			t.Error("unexpected method")
		}
	}))
	defer h.Close()
	c := Client{Token: "test", Base: h.URL, HTTP: h.Client()}
	updates, e := c.Updates(context.Background(), 123)
	if e != nil || len(updates) != 1 {
		t.Fatal(updates, e)
	}
	m := updates[0].ActorMessage()
	if m == nil || m.From.ID != 42 || m.From.Bot {
		t.Fatal("wrong actor")
	}
	if e = c.Answer(context.Background(), "cb"); e != nil {
		t.Fatal(e)
	}
	if e = c.Action(context.Background(), "42", "typing"); e != nil {
		t.Fatal(e)
	}
	updates[0].Callback.From.ID = 43
	if updates[0].ActorMessage() != nil {
		t.Fatal("accepted cross-chat callback")
	}
}

func TestUploadFloodWait(t *testing.T) {
	h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		w.Write([]byte(`{"ok":false,"error_code":429,"parameters":{"retry_after":19}}`))
	}))
	defer h.Close()
	c := Client{Token: "test", Base: h.URL, HTTP: h.Client(), Blobs: testBlob{}}
	_, e := c.MediaItem(context.Background(), "42", domain.Asset{Key: "one"})
	a, ok := e.(*APIError)
	if !ok || a.Code != 429 || a.RetryAfter != 19*time.Second {
		t.Fatal(e)
	}
}

func TestCodeEntityPreservesLiteralContent(t *testing.T) {
	const id = "63fe76a6-84c0-4090-8f3e-f279948a337e"
	text := "😀\n" + id + "\n正文 `<b>**literal**</b>`"
	for _, previous := range []int64{0, 12} {
		t.Run(fmt.Sprint(previous), func(t *testing.T) {
			h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if err := r.ParseForm(); err != nil {
					t.Error(err)
				}
				var entities []Entity
				if err := json.Unmarshal([]byte(r.Form.Get("entities")), &entities); err != nil {
					t.Error(err)
				}
				if len(entities) != 1 || entities[0].Type != "code" || entities[0].Offset != 3 || entities[0].Length != 36 {
					t.Errorf("incorrect code entity: %+v", entities)
				}
				if r.Form.Get("text") != text || r.Form.Get("parse_mode") != "" {
					t.Error("saved text changed or interpreted as markup")
				}
				w.Write([]byte(`{"ok":true,"result":{"message_id":12}}`))
			}))
			defer h.Close()
			c := &Client{Token: "test", Base: h.URL, HTTP: h.Client()}
			if _, err := c.WithCode(id).Send(context.Background(), "42", text, previous); err != nil {
				t.Fatal(err)
			}
			if c.codeText != "" {
				t.Fatal("shared client modified")
			}
		})
	}
}

func TestVideoDelivery(t *testing.T) {
	for _, album := range []bool{false, true} {
		t.Run(fmt.Sprint(album), func(t *testing.T) {
			h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if err := r.ParseMultipartForm(1 << 20); err != nil {
					t.Fatal(err)
				}
				defer r.MultipartForm.RemoveAll()
				if r.FormValue("reply_to_message_id") != "123" {
					t.Error("lost reply")
				}
				if album {
					if !strings.HasSuffix(r.URL.Path, "sendMediaGroup") {
						t.Error(r.URL.Path)
					}
					var media []map[string]any
					json.Unmarshal([]byte(r.FormValue("media")), &media)
					if media[0]["width"] != float64(192) || media[0]["height"] != float64(108) {
						t.Error("wrong video dimensions", media[0])
					}
					if len(media) != 2 || media[0]["type"] != "video" || media[1]["type"] != "photo" || media[0]["caption"] != "正文" {
						t.Error(media)
					}
					w.Write([]byte(`{"ok":true,"result":[{"message_id":7},{"message_id":8}]}`))
				} else {
					if r.FormValue("width") != "192" || r.FormValue("height") != "108" {
						t.Error("wrong video dimensions", r.Form)
					}
					if !strings.HasSuffix(r.URL.Path, "sendVideo") || r.FormValue("caption") != "正文" {
						t.Error(r.URL.Path, r.Form)
					}
					w.Write([]byte(`{"ok":true,"result":{"message_id":7}}`))
				}
			}))
			defer h.Close()
			c := Client{Token: "test", Base: h.URL, HTTP: h.Client(), Blobs: testBlob{}}
			aa := []domain.Asset{{Key: "video", MIME: "video/mp4"}}
			if album {
				aa = append(aa, domain.Asset{Key: "photo", MIME: "image/png"})
			}
			id, err := c.WithReplyTo(123).Media(context.Background(), "-42", aa, "正文")
			if err != nil || id != 7 {
				t.Fatal(id, err)
			}
		})
	}
}

func TestSourceLinksPreserveLiteralTextAndUTF16Offsets(t *testing.T) {
	text := "1. 😀作者：<正文>\n\n2. 😀作者：<正文>"
	links := []Entity{
		{Type: "text_link", Offset: 3, Length: 9, URL: "https://x.com/i/status/20"},
		{Type: "text_link", Offset: 17, Length: 9, URL: "https://x.com/i/status/21"},
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		var got []Entity
		if err := json.Unmarshal([]byte(r.Form.Get("entities")), &got); err != nil {
			t.Fatal(err)
		}
		if len(got) != 2 || got[0] != links[0] || got[1] != links[1] || r.Form.Get("text") != text || r.Form.Get("parse_mode") != "" {
			t.Errorf("lost literal source links: %+v", got)
		}
		w.Write([]byte(`{"ok":true,"result":{"message_id":1}}`))
	}))
	defer server.Close()
	c := &Client{Token: "test", Base: server.URL, HTTP: server.Client()}
	for _, previous := range []int64{0, 1} {
		if _, err := c.WithEntities(links).Send(context.Background(), "42", text, previous); err != nil {
			t.Fatal(err)
		}
	}
	if len(c.entities) != 0 {
		t.Fatal("shared client mutated")
	}
	detail := c.WithCode("id").WithEntities([]Entity{{Type: "text_link", Offset: 3, Length: 4, URL: links[0].URL}}).textEntities("id\n查看来源\n\n正文")
	if len(detail) != 2 || detail[0].URL != links[0].URL || detail[1].Type != "code" {
		t.Fatal(detail)
	}
}
