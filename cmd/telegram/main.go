package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"monitor/internal/tgchannel"
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	base := os.Getenv("CORE_CHANNEL_URL")
	if base == "" {
		base = "http://127.0.0.1:8081"
	}
	channel := os.Getenv("TELEGRAM_CHANNEL_ID")
	if channel == "" {
		slog.Error("TELEGRAM_CHANNEL_ID is required")
		os.Exit(1)
	}
	api := &tgchannel.Client{Base: base, Channel: channel, HTTP: &http.Client{Timeout: 5 * time.Minute}}
	runner := &tgchannel.Runner{API: api}
	if err := runner.Run(ctx); err != nil {
		slog.Error("telegram channel stopped", "error", err)
		os.Exit(1)
	}
}
