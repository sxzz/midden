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
)

func TestAuthenticatedProtocol(t *testing.T) {
	lis, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	srv := grpc.NewServer(grpc.UnaryInterceptor(Auth("test-token")))
	pb.RegisterAdapterServer(srv, &testServer{})
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
			ProtocolVersion: "1.0",
			AdapterId:       "x",
			Providers: []*pb.Provider{{
				Id: "fxtwitter", Capabilities: []*pb.Capability{{Name: "capture.fetch", Major: 1}}, Authentication: "none", Visibilities: []pb.Visibility{visibility},
			}},
		}
		valid := visibility == pb.Visibility_VISIBILITY_PUBLIC || visibility == pb.Visibility_VISIBILITY_PRIVATE
		if err := Validate(d); (err == nil) != valid {
			t.Fatalf("visibility %v: validation error = %v", visibility, err)
		}
	}
}

type testServer struct{ pb.UnimplementedAdapterServer }

func (*testServer) Describe(context.Context, *pb.DescribeRequest) (*pb.DescribeResponse, error) {
	return &pb.DescribeResponse{ProtocolVersion: ProtocolVersion, AdapterId: "minimal"}, nil
}

func TestProtocolEvolution(t *testing.T) {
	for _, tc := range []struct {
		version string
		valid   bool
	}{
		{"1.0", true},
		{"1.27", true},
		{"2.0", false},
		{"0.1", false},
		{"1", false},
		{"1.0.1", false},
		{"01.0", false},
		{"1.-1", false},
	} {
		t.Run(tc.version, func(t *testing.T) {
			// Neither platform, host matching, Fetch nor account authentication is mandatory.
			d := &pb.DescribeResponse{ProtocolVersion: tc.version, AdapterId: "search-only", Providers: []*pb.Provider{{Id: "index", Capabilities: []*pb.Capability{{Name: "future.search", Major: 7, Minor: 2}}}}}
			if err := Validate(d); (err == nil) != tc.valid {
				t.Fatalf("Validate = %v", err)
			}
		})
	}
	if err := Validate(nil); err == nil {
		t.Fatal("nil descriptor accepted")
	}
}

func TestCapabilityVersionMatching(t *testing.T) {
	p := &pb.Provider{Id: "text-only", Capabilities: []*pb.Capability{{Name: CaptureFetch, Major: 1, Minor: 2}, {Name: CaptureFetch, Major: 2}}}
	if !Supports(p, CaptureFetch, 1, 0) || !Supports(p, CaptureFetch, 1, 2) {
		t.Fatal("compatible capability not found")
	}
	if Supports(p, CaptureFetch, 1, 3) || Supports(p, CaptureFetch, 3, 0) || Supports(p, ConnectionCheck, 1, 0) || Supports(nil, CaptureFetch, 1, 0) {
		t.Fatal("unsupported capability accepted")
	}
	d := &pb.DescribeResponse{ProtocolVersion: ProtocolVersion, AdapterId: "minimal"}
	if err := Validate(d); err != nil {
		t.Fatal(err)
	}
	d.Providers = []*pb.Provider{{Id: "one", Capabilities: []*pb.Capability{{Name: "future.search", Major: 1}, {Name: "future.search", Major: 1, Minor: 1}}}}
	if err := Validate(d); err == nil {
		t.Fatal("ambiguous capability declaration accepted")
	}
	d.Providers = []*pb.Provider{{Id: "one"}, {Id: "one"}}
	if err := Validate(d); err == nil {
		t.Fatal("duplicate provider accepted")
	}
}
