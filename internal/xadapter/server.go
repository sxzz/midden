package xadapter

import (
	"context"
	"net/http"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "monitor/api/adapter/v1"
	"monitor/internal/domain"
	"monitor/internal/fxtwitter"
	"monitor/internal/xdown"
)

const Version = "0.2.0"

type TextSource interface {
	Text(context.Context, string) (string, error)
}

type Server struct {
	pb.UnimplementedAdapterServer
	Media *xdown.Server
	Text  TextSource
}

func New(client *http.Client) *Server {
	return &Server{Media: &xdown.Server{Client: client}, Text: &fxtwitter.Client{HTTP: client}}
}

func (s *Server) Describe(ctx context.Context, r *pb.DescribeRequest) (*pb.DescribeResponse, error) {
	d, err := s.Media.Describe(ctx, r)
	if err != nil {
		return nil, err
	}
	d.Version = Version
	return d, nil
}

// The selected xdown pipeline has fixed roles: xdown media and FxTwitter text.
// It does not change the persisted provider or account selection.
func (s *Server) Fetch(ctx context.Context, r *pb.FetchRequest) (*pb.FetchResponse, error) {
	if r.ConnectionId != "" || r.ProviderId != "xdown" || r.AccessScope != "public" {
		return nil, status.Error(codes.Unimplemented, "account authentication is not supported")
	}
	target, err := domain.Normalize(r.Url)
	if err != nil || target.ExternalID != r.ExternalId {
		return nil, status.Error(codes.InvalidArgument, "invalid post URL")
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	type result struct {
		text string
		err  error
	}
	textResult := make(chan result, 1)
	go func() {
		textCtx, stop := context.WithTimeout(ctx, 8*time.Second)
		defer stop()
		text, err := s.Text.Text(textCtx, target.ExternalID)
		textResult <- result{text, err}
	}()
	out, err := s.Media.Fetch(ctx, r)
	if err != nil {
		return nil, err
	}
	out.AdapterVersion = Version
	if out.Text != "" {
		out.TextSource = "xdown"
	}
	select {
	case <-ctx.Done():
		return nil, status.FromContextError(ctx.Err()).Err()
	case text := <-textResult:
		if text.err != nil {
			out.Incomplete = true
			out.Warnings = append(out.Warnings, "本次未能获取正文。")
		} else if text.text != "" {
			out.Text = text.text
			out.TextKind = "post_text"
			out.TextSource = "fxtwitter"
		}
	}
	return out, nil
}
