package xadapter

import (
	"context"
	"net/http"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "monitor/api/adapter/v1"
	"monitor/internal/domain"
	"monitor/internal/fxtwitter"
)

const Version = "0.3.0"

type Provider interface {
	Fetch(context.Context, string) (*pb.FetchResponse, error)
}
type Server struct {
	pb.UnimplementedAdapterServer
	Provider Provider
}

func New(client *http.Client) *Server { return &Server{Provider: &fxtwitter.Client{HTTP: client}} }
func (*Server) Describe(context.Context, *pb.DescribeRequest) (*pb.DescribeResponse, error) {
	return &pb.DescribeResponse{ProtocolVersion: "1", AdapterId: "x", Version: Version, Hosts: []string{"x.com", "twitter.com", "www.x.com", "www.twitter.com", "mobile.x.com", "mobile.twitter.com"}, Providers: []*pb.Provider{{Id: "fxtwitter", Authentication: "none", Visibility: pb.Visibility_VISIBILITY_PUBLIC}}, Capabilities: []string{"fetch_url", "text", "image", "video"}}, nil
}

func (s *Server) Fetch(ctx context.Context, r *pb.FetchRequest) (*pb.FetchResponse, error) {
	if r.ConnectionId != "" || r.ProviderId != "fxtwitter" || r.AccessScope != "public" {
		return nil, status.Error(codes.Unimplemented, "unsupported provider or account authentication")
	}
	target, err := domain.Normalize(r.Url)
	if err != nil || target.ExternalID != r.ExternalId {
		return nil, status.Error(codes.InvalidArgument, "invalid post URL")
	}
	out, err := s.Provider.Fetch(ctx, target.ExternalID)
	if err != nil {
		return nil, err
	}
	out.AdapterVersion = Version
	return out, nil
}
