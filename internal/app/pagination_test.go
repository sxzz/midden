package app

import (
	"context"
	"fmt"
	"os"
	"reflect"
	"testing"

	"github.com/google/uuid"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	"monitor/internal/domain"
	"monitor/internal/store"
)

func TestRecentBidirectionalPagination(t *testing.T) {
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
	owner, err := db.Resolve(ctx, channel, "owner", 1<<30)
	must(t, err)
	other, err := db.Resolve(ctx, channel, "other", 1<<30)
	must(t, err)
	q, err := river.NewClient(riverpgxv5.New(db.Pool), &river.Config{})
	must(t, err)
	s := &Service{DB: db, Queue: q, Adapter: &fakeAdapter{public: true, text: "pagination"}, Config: Defaults()}
	s.Config.Rate = 100
	for i := range 23 {
		job, err := s.Submit(ctx, owner.TenantID, domain.CaptureInput{URL: fmt.Sprintf("https://x.com/i/status/990001%05d", i)})
		must(t, err)
		must(t, s.capture(ctx, store.Task{Tenant: owner.TenantID, ID: job.ID}))
		must(t, s.finalize(ctx, owner.TenantID, job.ID))
	}
	// Equal timestamps must still paginate deterministically by collection ID.
	_, err = admin.Pool.Exec(ctx, `UPDATE tenant_collections SET created_at='2026-01-01' WHERE tenant_id=$1`, owner.TenantID)
	must(t, err)
	first, err := s.Recent(ctx, owner.TenantID, "")
	must(t, err)
	second, err := s.Recent(ctx, owner.TenantID, first.NextCursor)
	must(t, err)
	last, err := s.Recent(ctx, owner.TenantID, second.NextCursor)
	must(t, err)
	if len(first.Items) != 10 || len(second.Items) != 10 || len(last.Items) != 3 || first.PreviousCursor != "" || last.NextCursor != "" {
		t.Fatal("incorrect page boundaries", first, second, last)
	}
	seen := map[string]bool{}
	for _, p := range []domain.Page{first, second, last} {
		for _, a := range p.Items {
			if seen[a.ID] {
				t.Fatal("duplicate collection", a.ID)
			}
			seen[a.ID] = true
		}
		for _, cursor := range []string{p.NextCursor, p.PreviousCursor} {
			if cursor == "" {
				continue
			}
			if _, err := s.Recent(ctx, other.TenantID, cursor); err == nil {
				t.Fatal("foreign cursor accepted")
			}
		}
	}
	back, err := s.Recent(ctx, owner.TenantID, last.PreviousCursor)
	must(t, err)
	if !reflect.DeepEqual(back, second) {
		t.Fatal("backward page differs")
	}
	back, err = s.Recent(ctx, owner.TenantID, back.PreviousCursor)
	must(t, err)
	if !reflect.DeepEqual(back, first) {
		t.Fatal("first page differs after return")
	}
}
