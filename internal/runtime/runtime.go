package runtime

import (
	"context"
	"fmt"
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
)

func Run() error {
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

	vault, e := credentials.FromEnv()
	if e != nil {
		return e
	}
	s := &app.Service{Vault: vault, DB: db, Blobs: b, HTTP: &http.Client{Timeout: 5 * time.Minute}, Config: cfg}
	var endpointJSON string
	if e = db.Pool.QueryRow(ctx, `SELECT value FROM config WHERE key='additional_adapters'`).Scan(&endpointJSON); e != nil {
		return e
	}
	endpoints, e := adapterEndpoints(adapterEndpointConfig{
		Address: config.Get("ADAPTER_ADDRESS", "127.0.0.1:9091"),
		Token:   config.Required("ADAPTER_TOKEN"),
		TLSCA:   os.Getenv("ADAPTER_TLS_CA"),
	}, endpointJSON, os.Getenv("BUNDLED_ADAPTER_ADDRESSES"))
	if e != nil {
		return e
	}
	bindings := []app.AdapterEndpoint{}
	for _, endpoint := range endpoints {
		if endpoint.Address == "" || endpoint.Token == "" {
			return fmt.Errorf("adapter address and token required")
		}
		conn, err := adapter.Dial(endpoint.Address, endpoint.Token, endpoint.TLSCA)
		if err != nil {
			return err
		}
		defer conn.Close()
		bindings = append(bindings, app.AdapterEndpoint{Client: pb.NewAdapterClient(conn), TLS: endpoint.TLSCA != ""})
	}
	registry := app.NewAdapterRegistry(bindings)
	s.Registry = registry
	registryError := make(chan error, 1)
	// No network discovery is required to serve already saved content.
	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			if err := registry.Refresh(ctx); err != nil {
				if ctx.Err() == nil {
					slog.Error("adapter configuration invalid", "error", err)
					registryError <- err
					cancel()
				}
				return
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	workers := river.NewWorkers()
	river.AddWorker(workers, &app.Worker{S: s})
	q, e := river.NewClient(riverpgxv5.New(db.Pool), &river.Config{Workers: workers, Queues: queues(cfg), MaxAttempts: 3, RescueStuckJobsAfter: 6 * time.Minute, Logger: slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelWarn}))})
	if e != nil {
		return e
	}
	s.Queue = q
	if requiredConnections(cfg) > int(db.Pool.Config().MaxConns) {
		return &app.PermanentError{Message: "database pool too small for configured worker count"}
	}
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			if err := s.Maintain(ctx); err != nil && ctx.Err() == nil {
				slog.Warn("maintenance failed", "error", err)
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
	var webURL string
	if e = db.Pool.QueryRow(ctx, `SELECT value FROM config WHERE key='web_app_url'`).Scan(&webURL); e != nil {
		return e
	}
	webConfig := httpapi.WebConfig{URL: webURL, Token: token, Channel: channel}
	if e = httpapi.ValidateWebConfig(webConfig); e != nil {
		return e
	}
	if e = q.Start(ctx); e != nil {
		return e
	}
	defer func() {
		c, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		q.Stop(c)
	}()
	api := &http.Server{Addr: config.Get("HTTP_LISTEN", ":8080"), Handler: httpapi.WebHandler(s, webConfig), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 90 * time.Second, IdleTimeout: 5 * time.Minute}
	channelAPI := &http.Server{Addr: config.Get("CHANNEL_LISTEN", "127.0.0.1:8081"), Handler: httpapi.ChannelHandler(s), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, WriteTimeout: 5 * time.Minute}
	adminMux := http.NewServeMux()
	adminMux.Handle("/metrics", promhttp.Handler())
	adminMux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		if db.Pool.Ping(r.Context()) != nil {
			w.WriteHeader(503)
			return
		}
		w.Write([]byte("ok"))
	})
	adminDefault := "127.0.0.1:9090"

	admin := &http.Server{Addr: config.Get("ADMIN_LISTEN", adminDefault), Handler: adminMux, ReadHeaderTimeout: 5 * time.Second}
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
	go func() {
		if err := channelAPI.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			slog.Error("channel API stopped", "error", err)
			cancel()
		}
	}()
	slog.Info("core ready")
	<-ctx.Done()
	closeCtx, closeCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer closeCancel()
	channelAPI.Shutdown(closeCtx)
	api.Shutdown(closeCtx)
	admin.Shutdown(closeCtx)
	select {
	case err := <-registryError:
		return err
	default:
		return nil
	}
}
