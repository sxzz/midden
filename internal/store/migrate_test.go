package store

import (
	"context"
	"os"
	"sync"
	"testing"
	"testing/fstest"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestMigrationHistoryAndRollback(t *testing.T) {
	dsn := os.Getenv("TEST_ADMIN_DATABASE_URL")
	if dsn == "" {
		t.Skip("Docker database required")
	}
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	schema := pgx.Identifier{"migration_test_" + uuid.NewString()}.Sanitize()
	if _, err = conn.Exec(ctx, "CREATE SCHEMA "+schema+"; SET search_path TO "+schema); err != nil {
		t.Fatal(err)
	}
	defer conn.Exec(ctx, "DROP SCHEMA "+schema+" CASCADE")
	files := fstest.MapFS{"migrations/0001_initial.sql": {Data: []byte("CREATE TABLE example(id integer PRIMARY KEY, value text); INSERT INTO example VALUES(1,'saved');")}}
	apply := func(wantError bool) {
		t.Helper()
		if err := applyMigrations(ctx, conn, files); (err != nil) != wantError {
			t.Fatalf("migration error = %v, want error = %v", err, wantError)
		}
	}
	apply(false)
	apply(false) // CREATE TABLE cannot be replayed.
	files["migrations/20260927000000_add_column.sql"] = &fstest.MapFile{Data: []byte("ALTER TABLE example ADD COLUMN extra integer; UPDATE example SET extra=42;")}
	apply(false)
	var value string
	var extra int
	if err = conn.QueryRow(ctx, "SELECT value,extra FROM example WHERE id=1").Scan(&value, &extra); err != nil || value != "saved" || extra != 42 {
		t.Fatalf("data migration: %s %d %v", value, extra, err)
	}
	files["migrations/20260928000000_fail.sql"] = &fstest.MapFile{Data: []byte("UPDATE example SET value='lost'; CREATE TABLE transient(id integer); SELECT 1/0;")}
	apply(true)
	var count int
	if err = conn.QueryRow(ctx, "SELECT count(*) FROM schema_migrations").Scan(&count); err != nil || count != 2 {
		t.Fatal("failed migration was recorded", count, err)
	}
	var absent bool
	if err = conn.QueryRow(ctx, "SELECT to_regclass('transient') IS NULL").Scan(&absent); err != nil || !absent {
		t.Fatal("failed DDL was not rolled back", err)
	}
	if err = conn.QueryRow(ctx, "SELECT value FROM example WHERE id=1").Scan(&value); err != nil || value != "saved" {
		t.Fatal("failed DML was not rolled back", err)
	}
	delete(files, "migrations/20260928000000_fail.sql")
	initial := files["migrations/0001_initial.sql"]
	files["migrations/0001_initial.sql"] = &fstest.MapFile{Data: []byte("SELECT 1;")}
	apply(true) // Editing deployed history is rejected.
	files["migrations/0001_initial.sql"] = initial
	delete(files, "migrations/20260927000000_add_column.sql")
	apply(true) // An older build cannot migrate a newer database.
}

func TestConcurrentMigrate(t *testing.T) {
	dsn := os.Getenv("TEST_ADMIN_DATABASE_URL")
	if dsn == "" {
		t.Skip("Docker database required")
	}
	ctx := context.Background()
	db, err := Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var wg sync.WaitGroup
	for range 3 {
		wg.Go(func() {
			if err := db.Migrate(ctx); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	var version, count int
	if err = db.Pool.QueryRow(ctx, "SELECT version,(SELECT count(*) FROM schema_migrations) FROM schema_versions").Scan(&version, &count); err != nil || version != 1 || count != 2 {
		t.Fatal(version, count, err)
	}
}
