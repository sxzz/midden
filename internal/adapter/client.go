package adapter

import (
	"context"
	"crypto/subtle"
	"fmt"
	"strings"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	pb "monitor/api/adapter/v1"
)

func Auth(secret string) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, next grpc.UnaryHandler) (any, error) {
		md, _ := metadata.FromIncomingContext(ctx)
		v := md.Get("authorization")
		if len(v) != 1 || subtle.ConstantTimeCompare([]byte(v[0]), []byte("Bearer "+secret)) != 1 {
			return nil, status.Error(codes.Unauthenticated, "invalid adapter authentication")
		}
		return next(ctx, req)
	}
}

func Dial(address, secret, ca string) (*grpc.ClientConn, error) {
	if strings.TrimSpace(secret) == "" {
		return nil, fmt.Errorf("ADAPTER_TOKEN is required")
	}
	var c credentials.TransportCredentials = insecure.NewCredentials()
	if ca != "" {
		var e error
		c, e = credentials.NewClientTLSFromFile(ca, "")
		if e != nil {
			return nil, e
		}
	}
	return grpc.NewClient(address, grpc.WithTransportCredentials(c), grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(4<<20)), grpc.WithUnaryInterceptor(func(ctx context.Context, m string, req, reply any, cc *grpc.ClientConn, inv grpc.UnaryInvoker, opts ...grpc.CallOption) error {
		return inv(metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer "+secret), m, req, reply, cc, opts...)
	}))
}

func Validate(d *pb.DescribeResponse) error {
	if d.ProtocolVersion != "1" || d.AdapterId != "x" {
		return fmt.Errorf("incompatible adapter")
	}
	seen := map[string]bool{}
	for _, h := range d.Hosts {
		if seen[h] {
			return fmt.Errorf("conflicting host rule")
		}
		seen[h] = true
	}
	for _, p := range d.Providers {
		if p.Id == "xdown" && p.Authentication == "none" && (p.Visibility == pb.Visibility_VISIBILITY_PUBLIC || p.Visibility == pb.Visibility_VISIBILITY_PRIVATE) {
			return nil
		}
	}
	return fmt.Errorf("xdown provider unavailable")
}
