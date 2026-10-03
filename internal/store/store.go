package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"

	"monitor/internal/domain"
)

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
	case "download", "thumbnail":
		q = "download"
	}
	return river.InsertOpts{Queue: q, MaxAttempts: 3}
}
