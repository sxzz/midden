package fxtwitter

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

func TestTextResponse(t *testing.T) {
	for _, tc := range []struct {
		name, body, want string
		status           int
		bad              bool
	}{
		{"text", `{"code":200,"tweet":{"id":"20","text":"正文\\n第二行"}}`, "正文\\n第二行", 200, false},
		{"image only", `{"code":200,"tweet":{"id":"20","text":"","quote":{"text":"not this post"}}}`, "", 200, false},
		{"wrong id", `{"code":200,"tweet":{"id":"21","text":"other post"}}`, "", 200, true},
		{"missing text", `{"code":200,"tweet":{"id":"20"}}`, "", 200, true},
		{"invalid json", `<html>`, "", 200, true},
		{"limited", `{}`, "", 429, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/status/20" || r.Method != "GET" {
					t.Error("request target")
				}
				w.WriteHeader(tc.status)
				w.Write([]byte(tc.body))
			}))
			defer h.Close()
			c := Client{HTTP: h.Client(), Endpoint: h.URL + "/status/"}
			text, err := c.Text(context.Background(), "20")
			if (err != nil) != tc.bad || text != tc.want {
				t.Fatal(text, err)
			}
		})
	}
}

func TestTextCancellation(t *testing.T) {
	h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
	defer h.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	c := Client{HTTP: h.Client(), Endpoint: h.URL}
	if _, err := c.Text(ctx, "20"); err == nil {
		t.Fatal("expected cancellation")
	}
}

func TestReportedPostFixture(t *testing.T) {
	raw, err := os.ReadFile("testdata/post.json")
	if err != nil {
		t.Fatal(err)
	}
	h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write(raw) }))
	defer h.Close()
	c := Client{HTTP: h.Client(), Endpoint: h.URL}
	text, err := c.Text(context.Background(), "2103502762822795572")
	if err != nil || text != "来云南要吃菌子嘛？" {
		t.Fatal(text, err)
	}
}
