package store

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"testing/fstest"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestEntityMigrationPreservesExistingSnapshots(t *testing.T) {
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
	name := "entity_migration_" + uuid.NewString()
	dbname := pgx.Identifier{name}.Sanitize()
	if _, err = admin.Exec(ctx, "CREATE DATABASE "+dbname); err != nil {
		t.Fatal(err)
	}
	defer admin.Exec(ctx, "DROP DATABASE "+dbname+" WITH (FORCE)")
	cfg := admin.Config().Copy()
	cfg.Database = name
	conn, err := pgx.ConnectConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(ctx)
	initial, err := migrations.ReadFile("migrations/0001_initial.sql")
	if err != nil {
		t.Fatal(err)
	}
	if err = applyMigrations(ctx, conn, fstest.MapFS{"migrations/0001_initial.sql": {Data: initial}}); err != nil {
		t.Fatal(err)
	}
	tenant, collection, capture, revision, profile, pv := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	payload := `{"text":"original","text_kind":"post_text","warnings":[],"metadata":{"published_at":"2026-01-02T03:04:05Z","author":{"external_id":"user-123","username":"u","name":"Name","metadata":{"followers":42}}}}`
	// Seed the immutable initial schema; subsequent migrations rename these tables.
	queries := []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO tenants(id) VALUES($1)`, []any{tenant}},
		{`INSERT INTO archives(id,tenant_id,visibility,external_id,url,provider_id) VALUES($1,$2,'private','123','https://x.com/i/web/status/123','fxtwitter')`, []any{collection, tenant}},
		{`INSERT INTO captures(id,tenant_id,archive_id,provider_id,scope,state) VALUES($1,$2,$3,'fxtwitter','public','complete')`, []any{capture, tenant, collection}},
		{`INSERT INTO revisions(id,tenant_id,archive_id,capture_id,content_hash,payload,content_bytes) VALUES($1,$2,$3,$4,'old',$5,100)`, []any{revision, tenant, collection, capture, payload}},
		{`UPDATE archives SET current_revision=$2 WHERE id=$1`, []any{collection, revision}},
		{`INSERT INTO profiles(id,tenant_id,visibility,scope,external_id) VALUES($1,$2,'private','public','user-123')`, []any{profile, tenant}},
		{`INSERT INTO profile_versions(id,profile_id,tenant_id,visibility,content_hash,payload) VALUES($1,$2,$3,'private','old','{}')`, []any{pv, profile, tenant}},
		{`INSERT INTO revision_profiles(revision_id,profile_version_id,tenant_id,visibility) VALUES($1,$2,$3,'private')`, []any{revision, pv, tenant}},
		{`INSERT INTO source_responses(tenant_id,capture_id,position,visibility,body,content_type,source_url,sha256,size) VALUES($1,$2,0,'private','{}'::bytea,'application/json','https://example.test','hash',2)`, []any{tenant, capture}},
	}
	for _, q := range queries {
		if _, err = conn.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	if err = applyMigrations(ctx, conn, migrations); err != nil {
		t.Fatal(err)
	}
	if err = applyMigrations(ctx, conn, migrations); err != nil {
		t.Fatal("repeat migration", err)
	}
	var preserved bool
	if err = conn.QueryRow(ctx, `SELECT EXISTS(SELECT FROM collections c JOIN revisions r ON r.collection_id=c.id WHERE c.id=$1 AND c.current_revision=$2 AND r.id=$2) AND to_regclass('archives') IS NULL`, collection, revision).Scan(&preserved); err != nil || !preserved {
		t.Fatal("collection rename lost content", err)
	}
	var raw []byte
	if err = conn.QueryRow(ctx, `SELECT payload FROM revisions WHERE id=$1`, revision).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	var result struct {
		Metadata any
		Text     string
		Graph    struct {
			Root     string
			Entities []struct {
				ID   string
				Type string
				Data map[string]any
			}
			Relations []any
		}
	}
	if err = json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	if result.Metadata != nil || result.Text != "original" || len(result.Graph.Entities) != 2 || len(result.Graph.Relations) != 1 {
		t.Fatal("snapshot not migrated", string(raw))
	}
	found := false
	for _, e := range result.Graph.Entities {
		if e.Type == "x.profile" {
			found = e.ID == profile && e.Data["username"] == "u"
		}
	}
	if !found {
		t.Fatal("profile identity or payload lost")
	}
	var removed bool
	var sources, links, version int
	if err = conn.QueryRow(ctx, `SELECT to_regclass('profiles') IS NULL,(SELECT count(*) FROM source_responses),(SELECT count(*) FROM revision_entities),(SELECT version FROM schema_versions)`).Scan(&removed, &sources, &links, &version); err != nil || !removed || sources != 1 || links != 2 || version != 1 {
		t.Fatal("migration lost data or retained obsolete table", err)
	}
}
