package app

import (
	"context"
	"os"
	"strconv"
	"testing"

	"github.com/google/uuid"

	"monitor/internal/store"
)

func TestConfiguredRetention(t *testing.T) {
	if os.Getenv("TEST_DATABASE_URL") == "" {
		t.Skip("Docker database required")
	}
	ctx := context.Background()
	admin, e := store.Open(ctx, os.Getenv("TEST_ADMIN_DATABASE_URL"))
	must(t, e)
	defer admin.Close()
	db, e := store.Open(ctx, os.Getenv("TEST_DATABASE_URL"))
	must(t, e)
	defer db.Close()
	var days int64
	must(t, admin.Pool.QueryRow(ctx, `SELECT value::bigint FROM config WHERE key='archive_retention_days'`).Scan(&days))
	defer admin.Pool.Exec(ctx, `UPDATE config SET value=$1 WHERE key='archive_retention_days'`, strconv.FormatInt(days, 10))
	// Cleanup is global; use a no-op object store for unrelated garbage left by other tests.
	s := &Service{DB: db, Blobs: &memoryBlob{m: map[string][]byte{}}}
	var tenant, archive string
	must(t, admin.Pool.QueryRow(ctx, `INSERT INTO tenants DEFAULT VALUES RETURNING id`).Scan(&tenant))
	must(t, admin.Pool.QueryRow(ctx, `INSERT INTO archives(tenant_id,external_id,url,provider_id,platform,kind) VALUES($1,$2,'https://example.test/items/1','fixture','fixture','item') RETURNING id`, tenant, uuid.NewString()).Scan(&archive))
	_, e = admin.Pool.Exec(ctx, `INSERT INTO tenant_archives(tenant_id,archive_id,provider_id,adapter_id) VALUES($1,$2,'fixture','fixture')`, tenant, archive)
	must(t, e)
	must(t, s.DeleteArchive(ctx, tenant, archive))
	_, e = admin.Pool.Exec(ctx, `UPDATE archives SET unreferenced_at=now()-interval '2 days' WHERE id=$1`, archive)
	must(t, e)
	_, e = admin.Pool.Exec(ctx, `UPDATE config SET value=7 WHERE key='archive_retention_days'`)
	must(t, e)
	must(t, s.Maintain(ctx))
	var n int
	must(t, admin.Pool.QueryRow(ctx, `SELECT count(*) FROM archives WHERE id=$1`, archive).Scan(&n))
	if n != 1 {
		t.Fatal("archive removed before configured retention")
	}
	_, e = admin.Pool.Exec(ctx, `UPDATE config SET value=1 WHERE key='archive_retention_days'`)
	must(t, e)
	must(t, s.Maintain(ctx))
	must(t, admin.Pool.QueryRow(ctx, `SELECT count(*) FROM archives WHERE id=$1`, archive).Scan(&n))
	if n != 0 {
		t.Fatal("retention change did not take effect without restart")
	}
}
