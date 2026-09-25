package adapter

import (
	"context"
	"net"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/health"
	hp "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/status"

	pb "monitor/api/adapter/v1"
	"monitor/internal/xadapter"
)

func TestAuthenticatedProtocol(t *testing.T) {
	lis, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	srv := grpc.NewServer(grpc.UnaryInterceptor(Auth("test-token")))
	pb.RegisterAdapterServer(srv, &xadapter.Server{})
	h := health.NewServer()
	hp.RegisterHealthServer(srv, h)
	go srv.Serve(lis)
	defer srv.Stop()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	bad, e := Dial(lis.Addr().String(), "wrong", "")
	if e != nil {
		t.Fatal(e)
	}
	defer bad.Close()
	if _, e = pb.NewAdapterClient(bad).Describe(ctx, &pb.DescribeRequest{}); status.Code(e) != codes.Unauthenticated {
		t.Fatal(e)
	}
	conn, e := Dial(lis.Addr().String(), "test-token", "")
	if e != nil {
		t.Fatal(e)
	}
	defer conn.Close()
	c := pb.NewAdapterClient(conn)
	d, e := c.Describe(ctx, &pb.DescribeRequest{})
	if e != nil {
		t.Fatal(e)
	}
	if e = Validate(d); e != nil {
		t.Fatal(e)
	}
	if _, e = c.Fetch(ctx, &pb.FetchRequest{ConnectionId: "account"}); status.Code(e) != codes.Unimplemented {
		t.Fatal(e)
	}
	if _, e = hp.NewHealthClient(conn).Check(ctx, &hp.HealthCheckRequest{}); e != nil {
		t.Fatal(e)
	}
}

func TestProviderRequiresExplicitVisibility(t *testing.T) {
	for _, visibility := range []pb.Visibility{
		pb.Visibility_VISIBILITY_UNSPECIFIED,
		pb.Visibility_VISIBILITY_PUBLIC,
		pb.Visibility_VISIBILITY_PRIVATE,
		pb.Visibility(99),
	} {
		d := &pb.DescribeResponse{
			ProtocolVersion: "1",
			AdapterId:       "x",
			Providers: []*pb.Provider{{
				Id: "fxtwitter", Authentication: "none", Visibility: visibility,
			}},
		}
		valid := visibility == pb.Visibility_VISIBILITY_PUBLIC || visibility == pb.Visibility_VISIBILITY_PRIVATE
		if err := Validate(d); (err == nil) != valid {
			t.Fatalf("visibility %v: validation error = %v", visibility, err)
		}
	}
}
