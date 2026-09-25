package xadapter

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "monitor/api/adapter/v1"
	"monitor/internal/xdown"
)

type textFunc func(context.Context, string) (string, error)

func (f textFunc) Text(ctx context.Context, id string) (string, error) { return f(ctx, id) }

func TestCombinedCapture(t *testing.T) {
	for _, failure := range []bool{false, true} {
		t.Run(map[bool]string{false: "text and image", true: "text unavailable"}[failure], func(t *testing.T) {
			h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Write([]byte(`{"status":"ok","data":"<a class=\"abutton\" href=\"https://example.org/image.jpg\">下载图片</a>"}`))
			}))
			defer h.Close()
			s := &Server{Media: &xdown.Server{Client: h.Client(), Endpoint: h.URL}, Text: textFunc(func(ctx context.Context, id string) (string, error) {
				if id != "20" {
					t.Error("wrong text target")
				}
				if failure {
					return "", errors.New("upstream failure")
				}
				return "完整正文", nil
			})}
			out, err := s.Fetch(context.Background(), &pb.FetchRequest{Url: "https://x.com/i/web/status/20", ExternalId: "20", ProviderId: "xdown", AccessScope: "public"})
			if err != nil || len(out.Resources) != 1 || out.ProviderId != "xdown" || out.AdapterVersion != Version {
				t.Fatal(out, err)
			}
			if failure {
				if !out.Incomplete || len(out.Warnings) != 1 || out.Text != "" {
					t.Fatal(out)
				}
			} else if out.Text != "完整正文" || out.TextSource != "fxtwitter" || out.TextKind != "post_text" || out.Incomplete {
				t.Fatal(out)
			}
		})
	}
}

func TestAccountRequestDoesNotReachSources(t *testing.T) {
	s := &Server{}
	_, err := s.Fetch(context.Background(), &pb.FetchRequest{ConnectionId: "account"})
	if status.Code(err) != codes.Unimplemented {
		t.Fatal(err)
	}
}
