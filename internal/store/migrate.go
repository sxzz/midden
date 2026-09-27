package store

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"sort"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"github.com/riverqueue/river/rivermigrate"
)

//go:embed migrations/*.sql
var migrations embed.FS

const migrationLedger = `CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
)`

func (s *Store) Migrate(ctx context.Context) error {
	conn, err := s.Pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	if _, err = conn.Exec(ctx, `SELECT pg_advisory_lock(71789122)`); err != nil {
		return err
	}
	defer func() {
		// Never return a connection with a session lock to the pool.
		if _, err := conn.Exec(context.Background(), `SELECT pg_advisory_unlock(71789122)`); err != nil {
			conn.Conn().Close(context.Background())
		}
	}()
	if err = applyMigrations(ctx, conn.Conn(), migrations); err != nil {
		return err
	}
	m, err := rivermigrate.New(riverpgxv5.New(s.Pool), nil)
	if err != nil {
		return err
	}
	if _, err = m.Migrate(ctx, rivermigrate.DirectionUp, nil); err != nil {
		return err
	}
	_, err = conn.Exec(ctx, `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO monitor_app; REVOKE ALL ON tokens,schema_versions,schema_migrations FROM monitor_app; REVOKE INSERT,UPDATE,DELETE ON config FROM monitor_app; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO monitor_app;`)
	return err
}

// Caller holds the migration lock for the entire application and River upgrade.
func applyMigrations(ctx context.Context, conn *pgx.Conn, files fs.FS) error {
	names, err := fs.Glob(files, "migrations/*.sql")
	if err != nil || len(names) == 0 {
		return fmt.Errorf("no database migrations found: %v", err)
	}
	sort.Strings(names)
	if _, err = conn.Exec(ctx, migrationLedger); err != nil {
		return err
	}
	rows, err := conn.Query(ctx, `SELECT name,checksum FROM schema_migrations ORDER BY name`)
	if err != nil {
		return err
	}
	type appliedMigration struct{ name, checksum string }
	var applied []appliedMigration
	for rows.Next() {
		var m appliedMigration
		if err = rows.Scan(&m.name, &m.checksum); err != nil {
			rows.Close()
			return err
		}
		applied = append(applied, m)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return err
	}
	if len(applied) > len(names) {
		return fmt.Errorf("database has migrations absent from this build; downgrade refused")
	}
	// Validate the complete applied prefix before changing anything.
	for i, m := range applied {
		body, err := fs.ReadFile(files, names[i])
		if err != nil {
			return err
		}
		if m.name != names[i] || m.checksum != Hash(string(body)) {
			return fmt.Errorf("migration %s differs from database history; restore the applied file", m.name)
		}
	}
	for _, name := range names[len(applied):] {
		body, err := fs.ReadFile(files, name)
		if err != nil {
			return err
		}
		err = func() error {
			tx, err := conn.Begin(ctx)
			if err != nil {
				return err
			}
			defer tx.Rollback(context.Background())
			if _, err = tx.Exec(ctx, string(body)); err != nil {
				return err
			}
			if _, err = tx.Exec(ctx, `INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)`, name, Hash(string(body))); err != nil {
				return err
			}
			return tx.Commit(ctx)
		}()
		if err != nil {
			return fmt.Errorf("migration %s: %w", name, err)
		}
	}
	return nil
}
