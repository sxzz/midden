package xdown

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "monitor/api/adapter/v1"
)

func TestParse(t *testing.T) {
	b, e := os.ReadFile("testdata/images.html")
	if e != nil {
		t.Fatal(e)
	}
	v, e := Parse(string(b))
	if e != nil {
		t.Fatal(e)
	}
	if v.Text != "A & B" || len(v.Resources) != 2 || len(v.Warnings) != 1 {
		t.Fatalf("unexpected %+v", v)
	}
	if _, e = Parse(`<img src="https://example.org/thumb.jpg">`); e == nil {
		t.Fatal("thumbnail is not original image")
	}
	if _, e = Parse(`<a class="abutton" href="https://example.org/a.gif">下载 gif</a>`); e == nil {
		t.Fatal("unsupported-only content must fail")
	}
}

func TestProviderErrors(t *testing.T) {
	for _, tc := range []struct {
		code int
		body string
		want codes.Code
	}{{200, `{"status":"ok","msg":"no result"}`, codes.FailedPrecondition}, {200, `<html>captcha</html>`, codes.FailedPrecondition}, {429, ``, codes.Unavailable}, {503, ``, codes.Unavailable}, {403, ``, codes.FailedPrecondition}, {200, `{"status":"ok","data":"<h3>Hello</h3>"}`, codes.OK}} {
		t.Run(tc.body+string(rune(tc.code)), func(t *testing.T) {
			h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "POST" {
					t.Error("wrong method")
				}
				if err := r.ParseForm(); err != nil {
					t.Fatal(err)
				}
				if got := r.Form.Get("q"); got != "https://x.com/i/status/20" {
					t.Errorf("provider URL = %q", got)
				}
				w.Header().Set("Retry-After", "10")
				w.WriteHeader(tc.code)
				w.Write([]byte(tc.body))
			}))
			defer h.Close()
			s := Server{Client: h.Client(), Endpoint: h.URL}
			_, e := s.Fetch(context.Background(), &pb.FetchRequest{Url: "https://x.com/i/web/status/20", ExternalId: "20", ProviderId: "xdown", AccessScope: "public"})
			if status.Code(e) != tc.want {
				t.Fatalf("%v", e)
			}
		})
	}
}
