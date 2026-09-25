package telegram

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path"
	"strings"
	"testing"

	"monitor/internal/domain"
)

func TestGroupActor(t *testing.T) {
	for _, tc := range []struct {
		name, raw string
		want      int64
	}{
		{"group", `{"message":{"from":{"id":42},"chat":{"id":-42,"type":"group"}}}`, 42},
		{"supergroup", `{"message":{"from":{"id":42},"chat":{"id":-42,"type":"supergroup"}}}`, 42},
		{"callback actor", `{"callback_query":{"from":{"id":42},"message":{"from":{"id":999,"is_bot":true},"chat":{"id":-42,"type":"group"}}}}`, 42},
		{"anonymous", `{"message":{"from":{"id":42},"sender_chat":{"id":-42},"chat":{"id":-42,"type":"group"}}}`, 0},
		{"bot", `{"message":{"from":{"id":42,"is_bot":true},"chat":{"id":-42,"type":"group"}}}`, 0},
		{"channel", `{"message":{"from":{"id":42},"chat":{"id":-42,"type":"channel"}}}`, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var u Update
			if err := json.Unmarshal([]byte(tc.raw), &u); err != nil {
				t.Fatal(err)
			}
			m := u.ActorMessage()
			if tc.want == 0 {
				if m != nil {
					t.Fatal("unexpected actor")
				}
			} else if m == nil || m.From.ID != tc.want {
				t.Fatal("wrong actor")
			}
		})
	}
}

func TestGroupReplySurvivesFallbacks(t *testing.T) {
	h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method := path.Base(r.URL.Path)
		if strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/") {
			if err := r.ParseMultipartForm(1 << 20); err != nil {
				t.Error(err)
			}
			defer r.MultipartForm.RemoveAll()
		} else {
			r.ParseForm()
		}
		if method == "editMessageText" {
			fmt.Fprint(w, `{"ok":false,"error_code":400,"description":"message to edit not found"}`)
			return
		}
		if r.FormValue("reply_to_message_id") != "123" || r.FormValue("chat_id") != "-42" {
			t.Errorf("lost reply target in %s", method)
		}
		if r.FormValue("allow_sending_without_reply") == "true" {
			t.Error("must not send unthreaded fallback")
		}
		if method == "sendPhoto" || method == "sendDocument" {
			if r.FormValue("caption") != "正文" {
				t.Error("lost caption")
			}
		}
		if method == "sendPhoto" {
			fmt.Fprint(w, `{"ok":false,"error_code":400}`)
			return
		}
		fmt.Fprint(w, `{"ok":true,"result":{"message_id":7}}`)
	}))
	defer h.Close()
	base := &Client{Token: "test", Base: h.URL, HTTP: h.Client(), Blobs: testBlob{}}
	c := base.WithReplyTo(123)
	for _, part := range Split(strings.Repeat("文本", 4000)) {
		if _, err := c.Send(context.Background(), "-42", part, 12); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := c.Media(context.Background(), "-42", []domain.Asset{{Key: "one", MIME: "image/png"}}, "正文"); err != nil {
		t.Fatal(err)
	}
	if base.replyTo != 0 {
		t.Fatal("request mutated shared bot client")
	}
}
