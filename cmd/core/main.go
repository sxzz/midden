package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	pb "monitor/api/adapter/v1"
	"monitor/internal/adapter"
	"monitor/internal/app"
	"monitor/internal/blob"
	"monitor/internal/config"
	"monitor/internal/credentials"
	"monitor/internal/httpapi"
	"monitor/internal/store"
	"monitor/internal/telegram"
)

func main() {
	if e := run(); e != nil {
		slog.Error("core stopped", "error", e)
		os.Exit(1)
	}
}

func run() error {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	db, e := store.Open(ctx, config.Required("DATABASE_URL"))
	if e != nil {
		return e
	}
	defer db.Close()
	if e = db.CheckRole(ctx); e != nil {
		return e
	}
	cfg, e := config.Load(ctx, db)
	if e != nil {
		return e
	}
	b, e := blob.New(config.Required("S3_ENDPOINT"), config.Required("S3_ACCESS_KEY"), config.Required("S3_SECRET_KEY"), config.Required("S3_BUCKET"))
	if e != nil {
		return e
	}
	conn, e := adapter.Dial(config.Get("ADAPTER_ADDRESS", "127.0.0.1:9091"), config.Required("ADAPTER_TOKEN"), os.Getenv("ADAPTER_TLS_CA"))
	if e != nil {
		return e
	}
	defer conn.Close()
	client := pb.NewAdapterClient(conn)
	checkCtx, stop := context.WithTimeout(ctx, 15*time.Second)
	desc, e := client.Describe(checkCtx, &pb.DescribeRequest{})
	stop()
	if e != nil {
		return e
	}
	if e = adapter.Validate(desc); e != nil {
		return e
	}
	vault, e := credentials.FromEnv()
	if e != nil {
		return e
	}
	// Resource URLs come from trusted adapters; allow the deployment's proxy/DNS routing.
	entitySchemas, e := adapter.CompileEntityTypes(desc)
	if e != nil {
		return e
	}
	s := &app.Service{EntitySchemas: entitySchemas, Vault: vault, AdapterTLS: os.Getenv("ADAPTER_TLS_CA") != "", DB: db, Adapter: client, Providers: desc.Providers, Blobs: b, HTTP: &http.Client{Timeout: 5 * time.Minute}, Config: cfg}
	workers := river.NewWorkers()
	river.AddWorker(workers, &app.Worker{S: s})
	q, e := river.NewClient(riverpgxv5.New(db.Pool), &river.Config{Workers: workers, Queues: map[string]river.QueueConfig{"capture": {MaxWorkers: cfg.CaptureWorkers}, "download": {MaxWorkers: cfg.DownloadWorkers}, "control": {MaxWorkers: cfg.ControlWorkers}, "delivery": {MaxWorkers: cfg.DeliveryWorkers}}, MaxAttempts: 3, RescueStuckJobsAfter: 6 * time.Minute, Logger: slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelWarn}))})
	if e != nil {
		return e
	}
	s.Queue = q
	if 3*cfg.CaptureWorkers+cfg.DownloadWorkers+cfg.ControlWorkers+cfg.DeliveryWorkers+8 > int(db.Pool.Config().MaxConns) {
		return &app.PermanentError{Message: "database pool too small for configured worker count"}
	}
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			if err := s.Maintain(ctx); err != nil && ctx.Err() == nil {
				slog.Warn("maintenance failed")
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	token, channel, e := config.Telegram(ctx, db)
	if e != nil {
		return e
	}
	if token != "" {
		tg := &telegram.Client{Token: token, HTTP: &http.Client{Timeout: 5 * time.Minute}, Blobs: b, Cache: db}

		s.Senders = map[string]app.Sender{channel: tg}
		id, e := tg.Me(ctx)
		if e != nil {
			return e
		}
		var expected string
		if e = db.Pool.QueryRow(ctx, `SELECT external_id FROM channels WHERE id=$1 AND kind='telegram'`, channel).Scan(&expected); e != nil {
			return e
		}
		if id != expected {
			return &app.PermanentError{Message: "Bot identity does not match registered channel"}
		}
		commandsCtx, commandsCancel := context.WithTimeout(ctx, 5*time.Second)
		if err := tg.ConfigureCommands(commandsCtx, app.TelegramCommands(false), app.TelegramCommands(true)); err != nil {
			slog.Warn("Telegram command menu unavailable")
		}
		commandsCancel()
		go func() {
			if e = s.Poll(ctx, tg, channel); e != nil && ctx.Err() == nil {
				slog.Error("poller stopped")
				cancel()
			}
		}()
	}
	if e = q.Start(ctx); e != nil {
		return e
	}
	defer func() {
		c, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		q.Stop(c)
	}()
	api := &http.Server{Addr: config.Get("HTTP_LISTEN", ":8080"), Handler: httpapi.Handler(s), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 90 * time.Second, IdleTimeout: 5 * time.Minute}
	adminMux := http.NewServeMux()
	adminMux.Handle("/metrics", promhttp.Handler())
	adminMux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		if db.Pool.Ping(r.Context()) != nil {
			w.WriteHeader(503)
			return
		}
		w.Write([]byte("ok"))
	})
	admin := &http.Server{Addr: config.Get("ADMIN_LISTEN", "127.0.0.1:9090"), Handler: adminMux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		if err := api.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("API stopped")
			cancel()
		}
	}()
	go func() {
		if err := admin.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			cancel()
		}
	}()
	slog.Info("core ready")
	<-ctx.Done()
	closeCtx, closeCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer closeCancel()
	api.Shutdown(closeCtx)
	admin.Shutdown(closeCtx)
	return nil
}
