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
	files, err := migrations.ReadDir("migrations")
	if err != nil {
		t.Fatal(err)
	}
	var version, count int
	if err = db.Pool.QueryRow(ctx, "SELECT version,(SELECT count(*) FROM schema_migrations) FROM schema_versions").Scan(&version, &count); err != nil || version != 1 || count != len(files) {
		t.Fatal(version, count, err)
	}
}

// Branches add migrations independently and formatters rewrite files, so
// history is matched by name and normalized content, in whatever order the
// database happened to receive it.
func TestMigrationSetAndChecksums(t *testing.T) {
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
	files := fstest.MapFS{
		"migrations/0001_initial.sql":        {Data: []byte("create table example(id integer primary key, value text);")},
		"migrations/20260103000000_late.sql": {Data: []byte("ALTER TABLE example ADD COLUMN late integer;")},
	}
	apply := func(wantError bool) {
		t.Helper()
		if err := applyMigrations(ctx, conn, files); (err != nil) != wantError {
			t.Fatalf("migration error = %v, want error = %v", err, wantError)
		}
	}
	names := func() (out []string) {
		t.Helper()
		rows, err := conn.Query(ctx, "SELECT name FROM schema_migrations ORDER BY applied_at,name")
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		for rows.Next() {
			var name string
			if err = rows.Scan(&name); err != nil {
				t.Fatal(err)
			}
			out = append(out, name[len("migrations/"):])
		}
		return
	}
	apply(false)

	// A file merged later with an earlier name is applied, not refused.
	files["migrations/20260102000000_early.sql"] = &fstest.MapFile{Data: []byte("ALTER TABLE example ADD COLUMN early integer;")}
	apply(false)
	if got := names(); len(got) != 3 || got[2] != "20260102000000_early.sql" {
		t.Fatal("earlier-named migration was not applied last", got)
	}
	apply(false)

	// Reformatting an applied file keeps it the same migration.
	files["migrations/0001_initial.sql"] = &fstest.MapFile{Data: []byte("-- reformatted\nCREATE TABLE example (\n    id integer PRIMARY KEY,\n    value text\n);\n")}
	apply(false)

	// A checksum recorded over the raw bytes by an earlier build is accepted
	// while the file is unchanged, and replaced by the layout-independent one.
	late := string(files["migrations/20260103000000_late.sql"].Data)
	if _, err = conn.Exec(ctx, "UPDATE schema_migrations SET checksum=$2 WHERE name=$1", "migrations/20260103000000_late.sql", Hash(late)); err != nil {
		t.Fatal(err)
	}
	apply(false)
	var checksum string
	if err = conn.QueryRow(ctx, "SELECT checksum FROM schema_migrations WHERE name=$1", "migrations/20260103000000_late.sql").Scan(&checksum); err != nil || checksum != migrationChecksum(late) {
		t.Fatal("legacy checksum was not replaced", checksum, err)
	}
	files["migrations/20260103000000_late.sql"] = &fstest.MapFile{Data: []byte("alter table example\n  add column late integer;")}
	apply(false)

	// Changing what an applied file does is still refused.
	files["migrations/20260103000000_late.sql"] = &fstest.MapFile{Data: []byte("ALTER TABLE example ADD COLUMN late bigint;")}
	apply(true)
	files["migrations/20260103000000_late.sql"] = &fstest.MapFile{Data: []byte(late)}

	// Outside a transaction each statement commits on its own, the file is
	// recorded only after the last one, and a failed run starts over.
	files["migrations/20260104000000_index.sql"] = &fstest.MapFile{Data: []byte(noTransaction + "\nDROP INDEX CONCURRENTLY IF EXISTS example_value;\nCREATE INDEX CONCURRENTLY example_value ON example (value);\nSELECT 1/0;")}
	apply(true)
	var indexed, recorded bool
	if err = conn.QueryRow(ctx, "SELECT to_regclass('example_value') IS NOT NULL,EXISTS(SELECT FROM schema_migrations WHERE name LIKE '%_index.sql')").Scan(&indexed, &recorded); err != nil || !indexed || recorded {
		t.Fatal("partial non-transactional run", indexed, recorded, err)
	}
	files["migrations/20260104000000_index.sql"] = &fstest.MapFile{Data: []byte(noTransaction + "\nDROP INDEX CONCURRENTLY IF EXISTS example_value;\nCREATE INDEX CONCURRENTLY example_value ON example (value);")}
	apply(false)
	apply(false)
	if got := names(); len(got) != 4 || got[3] != "20260104000000_index.sql" {
		t.Fatal("non-transactional migration not recorded", got)
	}
}
