package fxtwitter

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"google.golang.org/genproto/googleapis/rpc/errdetails"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func TestFetch(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		code       codes.Code
		images     int
		incomplete bool
	}{
		{"text", `{"code":200,"status":{"type":"status","id":"20","text":"正文","media":{}}}`, codes.OK, 0, false},
		{"media", `{"code":200,"status":{"type":"status","id":"20","text":"","media":{"all":[{"type":"photo","url":"https://example.org/1.jpg"},{"type":"photo","url":"https://example.org/1.jpg"},{"type":"photo","url":"http://127.0.0.1/2.jpg"}]}}}`, codes.OK, 2, false},
		{"video", `{"code":200,"status":{"type":"status","id":"20","text":"正文","media":{"all":[{"type":"video","url":"https://example.org/video.mp4"}]}}}`, codes.OK, 1, false},
		{"invalid image", `{"code":200,"status":{"type":"status","id":"20","text":"正文","media":{"all":[{"type":"photo","url":"file:///secret"}]}}}`, codes.OK, 0, true},
		{"missing media", `{"code":200,"status":{"type":"status","id":"20","text":"正文"}}`, codes.OK, 0, true},
		{"empty", `{"code":200,"status":{"type":"status","id":"20","text":"","media":{}}}`, codes.FailedPrecondition, 0, false},
		{"private", `{"code":200,"status":{"type":"status","id":"20","text":"secret","author":{"protected":true}}}`, codes.FailedPrecondition, 0, false},
		{"tombstone", `{"code":200,"status":{"type":"tombstone"}}`, codes.FailedPrecondition, 0, false},
		{"wrong id", `{"code":200,"status":{"type":"status","id":"21","text":"other"}}`, codes.Unavailable, 0, false},
		{"missing text", `{"code":200,"status":{"type":"status","id":"20"}}`, codes.Unavailable, 0, false},
		{"invalid JSON", `<html>`, codes.Unavailable, 0, false},
		{"limited", `{"code":429}`, codes.Unavailable, 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/2/status/20" {
					t.Error(r.URL.Path)
				}
				w.Write([]byte(tc.body))
			}))
			defer h.Close()
			c := Client{HTTP: h.Client(), Endpoint: h.URL + "/2/status"}
			out, err := c.Fetch(context.Background(), "20")
			if status.Code(err) != tc.code {
				t.Fatal(out, err)
			}
			if err == nil && (len(out.Resources) != tc.images || out.Incomplete != tc.incomplete || out.ProviderId != "fxtwitter") {
				t.Fatal(out)
			}
		})
	}
}

func TestRetryAfter(t *testing.T) {
	for _, code := range []int{429, 503} {
		h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Header().Set("Retry-After", "30"); w.WriteHeader(code) }))
		c := Client{HTTP: h.Client(), Endpoint: h.URL}
		_, err := c.Fetch(context.Background(), "20")
		h.Close()
		st := status.Convert(err)
		if st.Code() != codes.Unavailable || len(st.Details()) != 1 {
			t.Fatal(err)
		}
		if st.Details()[0].(*errdetails.RetryInfo).RetryDelay.AsDuration() != 30*time.Second {
			t.Fatal(err)
		}
	}
}

func TestCancellation(t *testing.T) {
	h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
	defer h.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	c := Client{HTTP: h.Client(), Endpoint: h.URL}
	_, err := c.Fetch(ctx, "20")
	if status.Code(err) != codes.DeadlineExceeded {
		t.Fatal(err)
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
	out, err := c.Fetch(context.Background(), "2103502762822795572")
	if err != nil {
		t.Fatal(err)
	}
	if out.Text != "来云南要吃菌子嘛？" || len(out.Resources) != 1 || out.Resources[0].Url != "https://pbs.twimg.com/media/HTEkm7raUAAtnvf.jpg?name=orig" || out.Incomplete {
		t.Fatal(out)
	}
}

func TestVideoVariants(t *testing.T) {
	h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"code":200,"status":{"type":"status","id":"20","text":"","media":{"all":[{"id":"video-id","type":"gif","sensitive":true,"altText":"描述","url":"https://example.org/main.m3u8","thumbnail_url":"https://example.org/thumb.jpg","formats":[{"container":"mp4","codec":"h264","bitrate":100,"url":"https://example.org/low.mp4"},{"container":"mp4","codec":"hevc","bitrate":900,"url":"https://example.org/hevc.mp4"},{"container":"mp4","codec":"h264","bitrate":200,"url":"https://example.org/high.mp4"}]}]}}}`))
	}))
	defer h.Close()
	c := Client{HTTP: h.Client(), Endpoint: h.URL}
	out, err := c.Fetch(context.Background(), "20")
	if err != nil || len(out.Resources) != 1 || !out.Resources[0].Sensitive || out.Resources[0].AltText != "描述" || out.Resources[0].ImmutableKey != "video-id:/hevc.mp4" || out.Resources[0].Kind != "video" || out.Resources[0].Url != "https://example.org/hevc.mp4" {
		t.Fatal(out, err)
	}
}

func TestVideoResolutionPriority(t *testing.T) {
	h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"code":200,"status":{"type":"status","id":"20","text":"","media":{"all":[{"id":"media","type":"video","url":"https://example.org/low.mp4","formats":[{"container":"mp4","width":1280,"height":720,"bitrate":900,"url":"https://example.org/low.mp4"},{"container":"webm","width":1920,"height":1080,"bitrate":500,"url":"https://example.org/high.webm?token=temporary"}]}]}}}`))
	}))
	defer h.Close()
	c := Client{HTTP: h.Client(), Endpoint: h.URL}
	out, err := c.Fetch(context.Background(), "20")
	if err != nil || len(out.Resources) != 1 || out.Resources[0].Url != "https://example.org/high.webm?token=temporary" || out.Resources[0].ImmutableKey != "media:/high.webm" {
		t.Fatal(out, err)
	}
}

func TestPostSensitivityAppliesToAllMedia(t *testing.T) {
	h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"code":200,"status":{"type":"status","id":"20","text":"","possibly_sensitive":true,"media":{"all":[{"type":"photo","url":"https://example.org/image.jpg"},{"type":"video","url":"https://example.org/video.mp4"}]}}}`))
	}))
	defer h.Close()
	c := Client{HTTP: h.Client(), Endpoint: h.URL}
	out, err := c.Fetch(context.Background(), "20")
	if err != nil || len(out.Resources) != 2 {
		t.Fatal(out, err)
	}
	for _, r := range out.Resources {
		if !r.Sensitive {
			t.Fatal("post sensitivity lost")
		}
	}
}
