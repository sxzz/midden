package app

import (
	"context"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	"monitor/internal/domain"
	"monitor/internal/store"
)

// Quota checks read the total kept on the tenant. It has to be measured again
// once the tenant's own content changes, and at the latest after a minute.
func TestKeptUsageFollowsTenantContent(t *testing.T) {
	if os.Getenv("TEST_DATABASE_URL") == "" {
		t.Skip("Docker database required")
	}
	ctx := context.Background()
	admin, err := store.Open(ctx, os.Getenv("TEST_ADMIN_DATABASE_URL"))
	must(t, err)
	defer admin.Close()
	db, err := store.Open(ctx, os.Getenv("TEST_DATABASE_URL"))
	must(t, err)
	defer db.Close()
	channel := uuid.NewString()
	_, err = admin.Pool.Exec(ctx, `INSERT INTO channels(id,kind,external_id) VALUES($1,'test',$2)`, channel, channel)
	must(t, err)
	identity, err := db.Resolve(ctx, channel, "42", 1<<30)
	must(t, err)
	tenant := identity.TenantID
	q, err := river.NewClient(riverpgxv5.New(db.Pool), &river.Config{})
	must(t, err)
	s := &Service{DB: db, Queue: q, Adapter: &fakeAdapter{public: true, text: "kept usage"}, Config: Defaults()}
	save := func(url string) domain.Job {
		j, err := s.Submit(ctx, tenant, domain.CaptureInput{URL: url})
		must(t, err)
		must(t, s.capture(ctx, store.Task{Tenant: tenant, ID: j.ID, Type: "capture"}))
		must(t, s.finalize(ctx, tenant, j.ID))
		return j
	}
	// kept reads what a quota check would use; measured reports whether the
	// stored total is current.
	kept := func() (used int64) {
		must(t, db.Tx(ctx, tenant, func(tx pgx.Tx) error { return tx.QueryRow(ctx, `SELECT tenant_used()`).Scan(&used) }))
		return
	}
	measured := func() (ok bool) {
		must(t, admin.Pool.QueryRow(ctx, `SELECT used_at IS NOT NULL FROM tenants WHERE id=$1`, tenant).Scan(&ok))
		return
	}
	exact := func() int64 {
		u, err := s.Usage(ctx, tenant)
		must(t, err)
		return u.Used
	}

	first := save("https://x.com/i/status/98100000001")
	if measured() {
		t.Fatal("a finished capture left the kept total marked current")
	}
	one := kept()
	if one == 0 || one != exact() || !measured() {
		t.Fatal("kept total not measured after a capture", one, exact())
	}
	save("https://x.com/i/status/98100000002")
	two := kept()
	if two <= one || two != exact() {
		t.Fatal("kept total missed the tenant's next capture", one, two, exact())
	}

	must(t, s.DeleteCollection(ctx, tenant, first.CollectionID))
	if measured() {
		t.Fatal("removing a save left the kept total marked current")
	}
	if after := kept(); after >= two || after != exact() {
		t.Fatal("kept total not measured after a delete", two, after, exact())
	}

	// Changes the tenant did not make are picked up when the total expires.
	_, err = admin.Pool.Exec(ctx, `UPDATE tenants SET used_bytes=1,used_at=now()-interval '30 seconds' WHERE id=$1`, tenant)
	must(t, err)
	if kept() != 1 {
		t.Fatal("a fresh kept total was measured again")
	}
	_, err = admin.Pool.Exec(ctx, `UPDATE tenants SET used_at=now()-interval '2 minutes' WHERE id=$1`, tenant)
	must(t, err)
	if again := kept(); again != exact() {
		t.Fatal("an expired kept total was not measured again", again, exact())
	}

	// An unlimited tenant is never measured.
	_, err = admin.Pool.Exec(ctx, `INSERT INTO tenant_entitlements VALUES($1,true)`, tenant)
	must(t, err)
	_, err = admin.Pool.Exec(ctx, `UPDATE tenants SET used_at=NULL WHERE id=$1`, tenant)
	must(t, err)
	if kept() != 0 || measured() {
		t.Fatal("an unlimited tenant's usage was measured")
	}
}
