package xadapter

import (
	"context"
	"testing"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "monitor/api/adapter/v1"
)

type providerFunc func(context.Context, string) (*pb.FetchResponse, error)

func (f providerFunc) Fetch(c context.Context, id string) (*pb.FetchResponse, error) { return f(c, id) }
func TestFetch(t *testing.T) {
	s := &Server{Provider: providerFunc(func(_ context.Context, id string) (*pb.FetchResponse, error) {
		if id != "20" {
			t.Fatal(id)
		}
		return &pb.FetchResponse{Text: "正文", ProviderId: "fxtwitter", Visibility: pb.Visibility_VISIBILITY_PUBLIC}, nil
	})}
	out, err := s.Fetch(context.Background(), &pb.FetchRequest{Url: "https://x.com/i/web/status/20", ExternalId: "20", ProviderId: "fxtwitter", AccessScope: "public"})
	if err != nil || out.Text != "正文" || out.AdapterVersion != Version {
		t.Fatal(out, err)
	}
}

func TestUnsupportedRequests(t *testing.T) {
	for _, r := range []*pb.FetchRequest{
		{ConnectionId: "account"}, {ProviderId: "unknown", AccessScope: "public"}, {ProviderId: "fxtwitter", AccessScope: "private"},
	} {
		_, err := (&Server{}).Fetch(context.Background(), r)
		if status.Code(err) != codes.Unimplemented {
			t.Fatal(err)
		}
	}
	_, err := (&Server{}).Fetch(context.Background(), &pb.FetchRequest{Url: "https://x.com/user/status/20", ExternalId: "21", ProviderId: "fxtwitter", AccessScope: "public"})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatal(err)
	}
}
