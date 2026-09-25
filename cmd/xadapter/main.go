package main

import (
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/health"
	hp "google.golang.org/grpc/health/grpc_health_v1"

	pb "monitor/api/adapter/v1"
	"monitor/internal/adapter"
	"monitor/internal/xdown"
)

func main() {
	secret := os.Getenv("ADAPTER_TOKEN")
	if secret == "" {
		slog.Error("ADAPTER_TOKEN required")
		os.Exit(1)
	}
	addr := os.Getenv("ADAPTER_LISTEN")
	if addr == "" {
		addr = ":9091"
	}
	lis, e := net.Listen("tcp", addr)
	if e != nil {
		slog.Error("listen failed")
		os.Exit(1)
	}
	opts := []grpc.ServerOption{grpc.UnaryInterceptor(adapter.Auth(secret)), grpc.MaxRecvMsgSize(64 << 10)}
	if cert := os.Getenv("ADAPTER_TLS_CERT"); cert != "" {
		c, e := credentials.NewServerTLSFromFile(cert, os.Getenv("ADAPTER_TLS_KEY"))
		if e != nil {
			slog.Error("invalid TLS configuration")
			os.Exit(1)
		}
		opts = append(opts, grpc.Creds(c))
	}
	server := grpc.NewServer(opts...)
	pb.RegisterAdapterServer(server, &xdown.Server{Client: &http.Client{Timeout: 40 * time.Second}})
	h := health.NewServer()
	h.SetServingStatus("", hp.HealthCheckResponse_SERVING)
	hp.RegisterHealthServer(server, h)
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, os.Interrupt, syscall.SIGTERM)
	go func() { <-quit; server.GracefulStop() }()
	slog.Info("X adapter listening", "address", addr)
	if e = server.Serve(lis); e != nil {
		slog.Error("adapter stopped")
		os.Exit(1)
	}
}
