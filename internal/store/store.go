package store

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/riverqueue/river/rivermigrate"

	"monitor/internal/domain"
)

//go:embed schema.sql
var schema embed.FS

type Store struct{ Pool *pgxpool.Pool }

func Open(ctx context.Context, dsn string) (*Store, error) {
	cfg, e := pgxpool.ParseConfig(dsn)
	if e != nil {
		return nil, e
	}
	if cfg.MaxConns < 64 {
		cfg.MaxConns = 64
	}
	p, e := pgxpool.NewWithConfig(ctx, cfg)
	if e != nil {
		return nil, e
	}
	if e = p.Ping(ctx); e != nil {
		p.Close()
		return nil, e
	}
	return &Store{p}, nil
}

func (s *Store) Close() { s.Pool.Close() }
func (s *Store) CheckRole(ctx context.Context) error {
	var bad bool
	e := s.Pool.QueryRow(ctx, `SELECT rolsuper OR rolbypassrls OR EXISTS(SELECT FROM pg_class WHERE relname='tenants' AND relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)) FROM pg_roles WHERE rolname=current_user`).Scan(&bad)
	if e != nil {
		return e
	}
	if bad {
		return fmt.Errorf("runtime database role must not own tables, be superuser or bypass RLS")
	}
	return nil
}

func (s *Store) Migrate(ctx context.Context) error {
	conn, e := s.Pool.Acquire(ctx)
	if e != nil {
		return e
	}
	defer conn.Release()
	if _, e = conn.Exec(ctx, `SELECT pg_advisory_lock(71789122)`); e != nil {
		return e
	}
	defer conn.Exec(context.Background(), `SELECT pg_advisory_unlock(71789122)`)
	tx, e := conn.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	b, _ := schema.ReadFile("schema.sql")
	if _, e = tx.Exec(ctx, string(b)); e != nil {
		return e
	}
	if e = tx.Commit(ctx); e != nil {
		return e
	}
	m, e := rivermigrate.New(riverpgxv5.New(s.Pool), nil)
	if e != nil {
		return e
	}
	if _, e = m.Migrate(ctx, rivermigrate.DirectionUp, nil); e != nil {
		return e
	}
	_, e = s.Pool.Exec(ctx, `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO monitor_app; REVOKE ALL ON tokens,schema_versions FROM monitor_app; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO monitor_app;`)
	return e
}

func (s *Store) Tx(ctx context.Context, tenant string, fn func(pgx.Tx) error) error {
	tx, e := s.Pool.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, `SELECT set_config('app.tenant_id',$1,true)`, tenant); e != nil {
		return e
	}
	if e = fn(tx); e != nil {
		return translate(e)
	}
	return tx.Commit(ctx)
}

func translate(e error) error {
	if errors.Is(e, pgx.ErrNoRows) {
		return domain.ErrNotFound
	}
	return e
}

func (s *Store) Resolve(ctx context.Context, channel, user string, quota int64) (domain.Identity, error) {
	v := domain.Identity{ChannelID: channel, ExternalID: user}
	e := s.Pool.QueryRow(ctx, `SELECT identity_id,tenant_id FROM resolve_identity($1,$2,$3)`, channel, user, quota).Scan(&v.ID, &v.TenantID)
	return v, e
}

func Hash(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }
func (s *Store) Authenticate(ctx context.Context, token string) (string, error) {
	var t *string
	e := s.Pool.QueryRow(ctx, `SELECT authenticate_token($1)`, Hash(token)).Scan(&t)
	if e != nil {
		return "", e
	}
	if t == nil {
		return "", domain.ErrNotFound
	}
	return *t, nil
}

type Task struct {
	Tenant string `json:"tenant"`
	ID     string `json:"id"`
	Type   string `json:"type"`
}

func (Task) Kind() string { return "monitor_task" }
func (t Task) InsertOpts() river.InsertOpts {
	q := "control"
	switch t.Type {
	case "capture":
		q = "capture"
	case "download":
		q = "download"
	case "deliver", "reply":
		q = "delivery"
	}
	return river.InsertOpts{Queue: q, MaxAttempts: 3}
}
