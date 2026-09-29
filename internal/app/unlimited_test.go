package app

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"monitor/internal/domain"
	"monitor/internal/store"
)

func TestUnlimitedTenant(t *testing.T) {
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
	tenant := uuid.NewString()
	_, e = admin.Pool.Exec(ctx, "INSERT INTO tenants(id,quota_bytes,rate_count) VALUES($1,1,10)", tenant)
	must(t, e)
	q, e := river.NewClient(riverpgxv5.New(db.Pool), &river.Config{})
	must(t, e)
	s := &Service{DB: db, Queue: q, Adapter: &fakeAdapter{text: "text exceeds one byte"}, Config: Defaults()}
	input := domain.CaptureInput{URL: "https://x.com/example/status/999000100"}
	_, e = s.Submit(ctx, tenant, input)
	if !errors.Is(e, domain.ErrRate) {
		t.Fatalf("expected rate limit, got %v", e)
	}
	_, e = admin.Pool.Exec(ctx, "INSERT INTO tenant_entitlements VALUES($1,true)", tenant)
	must(t, e)
	e = db.Tx(ctx, tenant, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, "UPDATE tenant_entitlements SET unlimited=false WHERE tenant_id=$1", tenant)
		return err
	})
	if e == nil {
		t.Fatal("business role changed entitlement")
	}
	for i := 0; i < 4; i++ {
		c, slot, err := s.slot(ctx, tenant)
		must(t, err)
		if c != nil {
			release(c, tenant, slot)
			t.Fatal("unlimited tenant acquired bounded slot")
		}
	}
	job, e := s.Submit(ctx, tenant, input)
	must(t, e)
	must(t, s.capture(ctx, store.Task{Tenant: tenant, ID: job.ID}))
	must(t, s.finalize(ctx, tenant, job.ID))
	u, e := s.Usage(ctx, tenant)
	must(t, e)
	if !u.Unlimited || u.Used <= u.Limit {
		t.Fatalf("usage not tracked beyond quota: %+v", u)
	}
	// Entitlements cannot be read across tenants.
	other := uuid.NewString()
	_, e = admin.Pool.Exec(ctx, "INSERT INTO tenants(id) VALUES($1)", other)
	must(t, e)
	e = db.Tx(ctx, other, func(tx pgx.Tx) error {
		var yes bool
		err := tx.QueryRow(ctx, "SELECT tenant_unlimited()").Scan(&yes)
		if yes {
			t.Fatal("foreign entitlement exposed")
		}
		return err
	})
	must(t, e)
	_, e = admin.Pool.Exec(ctx, "UPDATE tenant_entitlements SET unlimited=false WHERE tenant_id=$1", tenant)
	must(t, e)
	_, e = s.Submit(ctx, tenant, domain.CaptureInput{URL: "https://x.com/example/status/999000101"})
	if !errors.Is(e, domain.ErrQuota) {
		t.Fatalf("revocation did not restore quota: %v", e)
	}
}
