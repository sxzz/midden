package store

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
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
	_, err = conn.Exec(ctx, `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO monitor_app; REVOKE ALL ON tokens,schema_versions,schema_migrations FROM monitor_app; REVOKE INSERT,UPDATE,DELETE ON config,tenant_entitlements FROM monitor_app; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO monitor_app;`)
	return err
}

// A migration that starts with this line runs statement by statement outside
// a transaction, for DDL such as CREATE INDEX CONCURRENTLY.
const noTransaction = "-- migrate: no-transaction"

// migrationChecksum identifies a migration by its normalized SQL, so running
// the formatter over an applied file does not turn it into a different one.
func migrationChecksum(body string) string { return "2:" + Hash(normalizeSQL(body)) }

// Caller holds the migration lock for the entire application and River upgrade.
//
// History is a set, not a prefix: branches that each add a migration merge in
// either order, and whichever file a database has not seen yet is applied.
// What stays fixed is that an applied file is never edited or removed.
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
	applied := map[string]string{}
	for rows.Next() {
		var name, checksum string
		if err = rows.Scan(&name, &checksum); err != nil {
			rows.Close()
			return err
		}
		applied[name] = checksum
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return err
	}
	// Validate the complete applied history before changing anything.
	bodies := make(map[string]string, len(names))
	var pending, legacy []string
	for _, name := range names {
		body, err := fs.ReadFile(files, name)
		if err != nil {
			return err
		}
		bodies[name] = string(body)
		recorded, ok := applied[name]
		switch {
		case !ok:
			pending = append(pending, name)
		case recorded == migrationChecksum(string(body)):
		case recorded == Hash(string(body)):
			// Recorded over the raw bytes by an earlier build.
			legacy = append(legacy, name)
		default:
			return fmt.Errorf("migration %s differs from database history; restore the applied file", name)
		}
		delete(applied, name)
	}
	if len(applied) > 0 {
		absent := make([]string, 0, len(applied))
		for name := range applied {
			absent = append(absent, name)
		}
		sort.Strings(absent)
		return fmt.Errorf("database has migrations absent from this build (%s); downgrade refused", strings.Join(absent, ", "))
	}
	for _, name := range legacy {
		if _, err = conn.Exec(ctx, `UPDATE schema_migrations SET checksum=$2 WHERE name=$1`, name, migrationChecksum(bodies[name])); err != nil {
			return err
		}
	}
	for _, name := range pending {
		if err = applyMigration(ctx, conn, name, bodies[name]); err != nil {
			return fmt.Errorf("migration %s: %w", name, err)
		}
	}
	return nil
}

func applyMigration(ctx context.Context, conn *pgx.Conn, name, body string) error {
	record := func(q interface {
		Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	},
	) error {
		_, err := q.Exec(ctx, `INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)`, name, migrationChecksum(body))
		return err
	}
	if first, _, _ := strings.Cut(strings.TrimLeft(body, " \t\r\n"), "\n"); strings.TrimSpace(first) == noTransaction {
		// Nothing rolls back here. The file is recorded only once every
		// statement has succeeded, so a failed run starts over from the top
		// and each statement has to tolerate having run before.
		for _, statement := range splitSQL(body) {
			if _, err := conn.Exec(ctx, statement); err != nil {
				return err
			}
		}
		return record(conn)
	}
	tx, err := conn.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, body); err != nil {
		return err
	}
	if err = record(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
