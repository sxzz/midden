package store

import (
	"context"
	"io/fs"
	"net/url"
	"os"
	"testing"
	"testing/fstest"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestBaselineMigrate(t *testing.T) {
	dsn := os.Getenv("TEST_ADMIN_DATABASE_URL")
	if dsn == "" {
		t.Skip("Docker database required")
	}
	ctx := context.Background()
	admin, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close(ctx)
	name := "baseline_test_" + uuid.NewString()
	identifier := pgx.Identifier{name}.Sanitize()
	if _, err = admin.Exec(ctx, "CREATE DATABASE "+identifier); err != nil {
		t.Fatal(err)
	}
	defer admin.Exec(ctx, "DROP DATABASE "+identifier+" WITH (FORCE)")
	testURL, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	testURL.Path = "/" + name
	db, err := Open(ctx, testURL.String())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	// Upgrade a deployed baseline containing an existing user, then repeat migration.
	baseline, err := migrations.ReadFile("migrations/0001_initial.sql")
	if err != nil {
		t.Fatal(err)
	}
	conn, err := db.Pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	err = applyMigrations(ctx, conn.Conn(), fstest.MapFS{"migrations/0001_initial.sql": {Data: baseline}})
	conn.Release()
	if err != nil {
		t.Fatal(err)
	}
	tenant, channel, identity := uuid.NewString(), uuid.NewString(), uuid.NewString()
	if _, err = db.Pool.Exec(ctx, `INSERT INTO tenants(id) VALUES($1)`, tenant); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Pool.Exec(ctx, `INSERT INTO channels(id,kind,external_id) VALUES($1,'telegram','fixture')`, channel); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Pool.Exec(ctx, `INSERT INTO identities(id,tenant_id,channel_id,external_id) VALUES($1,$2,$3,'42')`, identity, tenant, channel); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err = db.Migrate(ctx); err != nil {
			t.Fatal(err)
		}
	}

	var savedTenant, first, last, username string
	if err = db.Pool.QueryRow(ctx, `SELECT tenant_id,first_name,last_name,username FROM identities WHERE id=$1`, identity).Scan(&savedTenant, &first, &last, &username); err != nil || savedTenant != tenant || first != "" || last != "" || username != "" {
		t.Fatalf("upgraded identity changed: %v", err)
	}
	names, err := fs.Glob(migrations, "migrations/*.sql")
	if err != nil {
		t.Fatal(err)
	}
	var count, version int
	var filename, checksum string
	if err = db.Pool.QueryRow(ctx, `SELECT count(*) FROM schema_migrations`).Scan(&count); err != nil || count != len(names) {
		t.Fatalf("baseline ledger count = %d: %v", count, err)
	}
	if err = db.Pool.QueryRow(ctx, `SELECT name,checksum FROM schema_migrations WHERE name='migrations/0001_initial.sql'`).Scan(&filename, &checksum); err != nil {
		t.Fatal(err)
	}
	body, err := migrations.ReadFile("migrations/0001_initial.sql")
	if err != nil || filename != "migrations/0001_initial.sql" || checksum != migrationChecksum(string(body)) {
		t.Fatalf("baseline ledger = %q %q: %v", filename, checksum, err)
	}
	if err = db.Pool.QueryRow(ctx, `SELECT version FROM schema_versions`).Scan(&version); err != nil || version != 1 {
		t.Fatalf("schema version = %d: %v", version, err)
	}
	for _, table := range []string{"archives", "tenant_archives", "profiles", "profile_versions", "revision_profiles"} {
		var absent bool
		if err = db.Pool.QueryRow(ctx, `SELECT to_regclass($1) IS NULL`, "public."+table).Scan(&absent); err != nil || !absent {
			t.Fatalf("legacy table %s exists: %v", table, err)
		}
	}
	for key, want := range map[string]string{
		"tenant_quota_bytes": "1073741824", "collection_retention_days": "7",
		"web_app_url": "", "telegram_bot_token": "", "additional_adapters": "[]",
	} {
		var got string
		if err = db.Pool.QueryRow(ctx, `SELECT value FROM config WHERE key=$1`, key).Scan(&got); err != nil || got != want {
			t.Fatalf("default %s = %q, want %q: %v", key, got, want, err)
		}
	}

	tenant, other := uuid.NewString(), uuid.NewString()
	var quota int64
	if err = db.Pool.QueryRow(ctx, `INSERT INTO tenants(id) VALUES($1) RETURNING quota_bytes`, tenant).Scan(&quota); err != nil || quota != 1073741824 {
		t.Fatalf("tenant quota default = %d: %v", quota, err)
	}
	if _, err = db.Pool.Exec(ctx, `INSERT INTO tenants(id) VALUES($1)`, other); err != nil {
		t.Fatal(err)
	}
	var unlimited bool
	if err = db.Pool.QueryRow(ctx, `INSERT INTO tenant_entitlements(tenant_id) VALUES($1) RETURNING unlimited`, tenant).Scan(&unlimited); err != nil || unlimited {
		t.Fatalf("unlimited default = %v: %v", unlimited, err)
	}
	var sessionDefault bool
	if err = db.Pool.QueryRow(ctx, `INSERT INTO web_sessions(digest,tenant_id) VALUES('fixture',$1) RETURNING expires_at=now()+interval '12 hours'`, tenant).Scan(&sessionDefault); err != nil || !sessionDefault {
		t.Fatalf("web session expiry default: %v", err)
	}

	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SET LOCAL ROLE monitor_app`); err != nil {
		t.Fatal(err)
	}
	for _, privilege := range []struct {
		table, operation string
		allowed          bool
	}{
		{"config", "SELECT", true},
		{"config", "INSERT", false},
		{"config", "UPDATE", false},
		{"config", "DELETE", false},
		{"tenant_entitlements", "SELECT", true},
		{"tenant_entitlements", "INSERT", false},
		{"tenant_entitlements", "UPDATE", false},
		{"tenant_entitlements", "DELETE", false},
		{"tokens", "SELECT", false},
		{"schema_migrations", "SELECT", false},
		{"schema_versions", "SELECT", false},
		{"channel_work", "INSERT", true},
		{"web_sessions", "INSERT", true},
	} {
		var allowed bool
		if err = tx.QueryRow(ctx, `SELECT has_table_privilege(current_user,$1,$2)`, "public."+privilege.table, privilege.operation).Scan(&allowed); err != nil || allowed != privilege.allowed {
			t.Fatalf("%s %s privilege = %v, want %v: %v", privilege.table, privilege.operation, allowed, privilege.allowed, err)
		}
	}
	if _, err = tx.Exec(ctx, `SELECT set_config('app.tenant_id',$1,true)`, tenant); err != nil {
		t.Fatal(err)
	}
	var visible string
	if err = tx.QueryRow(ctx, `SELECT count(*),min(id::text) FROM tenants`).Scan(&count, &visible); err != nil || count != 1 || visible != tenant {
		t.Fatalf("tenant isolation: count=%d tenant=%s: %v", count, visible, err)
	}
	result, err := tx.Exec(ctx, `UPDATE tenants SET reserved_bytes=1 WHERE id=$1`, other)
	if err != nil || result.RowsAffected() != 0 {
		t.Fatalf("cross-tenant update affected %d: %v", result.RowsAffected(), err)
	}
}
