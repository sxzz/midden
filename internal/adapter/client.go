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
	return grpc.NewClient(address, grpc.WithTransportCredentials(c), grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(8<<20)), grpc.WithUnaryInterceptor(func(ctx context.Context, m string, req, reply any, cc *grpc.ClientConn, inv grpc.UnaryInvoker, opts ...grpc.CallOption) error {
		return inv(metadata.AppendToOutgoingContext(ctx, "authorization", "Bearer "+secret), m, req, reply, cc, opts...)
	}))
}
