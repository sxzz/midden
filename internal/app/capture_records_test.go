package app

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	"monitor/internal/domain"
	"monitor/internal/store"
)

func TestCaptureRecords(t *testing.T) {
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
	queue, e := river.NewClient(riverpgxv5.New(db.Pool), &river.Config{})
	must(t, e)
	prefix := strings.ReplaceAll(uuid.NewString(), "-", "")
	fake := &datedAdapter{collectionAdapter: &collectionAdapter{&fakeAdapter{}}, members: map[string]string{prefix + "-a": "", prefix + "-b": ""}}
	cfg := Defaults()
	cfg.Rate = 1000
	s := &Service{DB: db, Queue: queue, Adapter: fake, Config: cfg}
	var tenant, other string
	must(t, admin.Pool.QueryRow(ctx, "INSERT INTO tenants DEFAULT VALUES RETURNING id").Scan(&tenant))
	must(t, admin.Pool.QueryRow(ctx, "INSERT INTO tenants DEFAULT VALUES RETURNING id").Scan(&other))
	complete := func(id string) {
		must(t, s.capture(ctx, store.Task{Tenant: tenant, ID: id}))
		must(t, s.finalize(ctx, tenant, id))
	}
	records := func() []CaptureRecord {
		p, e := s.CaptureRecords(ctx, tenant, "")
		must(t, e)
		return p.Items
	}

	entry, e := s.CaptureURL(ctx, tenant, "https://notes.test/entry/"+prefix+"-single", "")
	must(t, e)
	listing, e := s.CaptureURL(ctx, tenant, "https://notes.test/collection/"+prefix, "")
	must(t, e)
	list := records()
	if len(list) != 2 || list[0].JobID != listing.ID || list[1].JobID != entry.ID {
		t.Fatalf("records are not the two requests, newest first: %+v", list)
	}
	if r := list[0]; r.State != "queued" || r.Done || r.Members == nil || r.Kind != "collection" || !r.Saved {
		t.Fatalf("queued collection record %+v", r)
	}
	if r := list[1]; r.Done || r.Members != nil || r.Input != "https://notes.test/entry/"+prefix+"-single" {
		t.Fatalf("queued entry record %+v", r)
	}
	record := list[0].ID

	complete(entry.ID)
	complete(listing.ID)
	must(t, s.related(ctx, store.Task{Tenant: tenant, ID: record, Type: "related"}))
	rows, e := admin.Pool.Query(ctx, `SELECT capture_id FROM submissions WHERE parent_submission=$1 ORDER BY created_at`, record)
	must(t, e)
	members, e := pgx.CollectRows(rows, pgx.RowTo[string])
	must(t, e)
	if len(members) != 2 {
		t.Fatalf("members submitted: %v", members)
	}
	// Member captures stay inside their collection's record.
	if list = records(); len(list) != 2 || list[0].Done || list[0].Members.Pending != 2 || !list[1].Done {
		t.Fatalf("records while members run: %+v", list)
	}
	complete(members[0])
	must(t, s.fail(ctx, store.Task{Tenant: tenant, ID: members[1], Type: "capture"}, "post unavailable"))

	detail, e := s.CaptureRecord(ctx, tenant, record)
	must(t, e)
	if m := detail.Members; !detail.Done || m.Complete != 1 || m.Failed != 1 || m.Pending != 0 {
		t.Fatalf("finished record %+v %+v", detail.CaptureRecord, m)
	}
	if len(detail.Reasons) != 1 || detail.Reasons[0] != (CaptureReason{Reason: "post unavailable", Count: 1}) {
		t.Fatalf("failure reasons %+v", detail.Reasons)
	}
	all, e := s.CaptureMembers(ctx, tenant, record, "", "")
	must(t, e)
	failed, e := s.CaptureMembers(ctx, tenant, record, "problem", "")
	must(t, e)
	if len(all.Items) != 2 || len(failed.Items) != 1 || failed.Items[0].JobID != members[1] || failed.Items[0].Error != "post unavailable" {
		t.Fatalf("members %+v, failed %+v", all.Items, failed.Items)
	}
	if _, e = s.CaptureMembers(ctx, tenant, record, "unknown", ""); !errors.Is(e, ErrInvalidFilter) {
		t.Fatal("accepted an unknown member state", e)
	}

	// Another tenant sees none of it and cannot act on it.
	if p, e := s.CaptureRecords(ctx, other, ""); e != nil || len(p.Items) != 0 {
		t.Fatalf("foreign records %+v %v", p.Items, e)
	}
	if _, e = s.CaptureRecord(ctx, other, record); !errors.Is(e, domain.ErrNotFound) {
		t.Fatal("foreign record read", e)
	}
	if _, e = s.CaptureMembers(ctx, other, record, "", ""); !errors.Is(e, domain.ErrNotFound) {
		t.Fatal("foreign members read", e)
	}
	if _, e = s.RetryCaptureRecord(ctx, other, record, ""); !errors.Is(e, domain.ErrNotFound) {
		t.Fatal("foreign retry permitted", e)
	}
	// A member's own submission is not a record.
	var member string
	must(t, admin.Pool.QueryRow(ctx, `SELECT id FROM submissions WHERE parent_submission=$1 LIMIT 1`, record).Scan(&member))
	if _, e = s.CaptureRecord(ctx, tenant, member); !errors.Is(e, domain.ErrNotFound) {
		t.Fatal("member submission read as a record", e)
	}

	// Retrying adds a record with its own capture and leaves the old one as it was.
	again, e := s.RetryCaptureRecord(ctx, tenant, record, "")
	must(t, e)
	if list = records(); len(list) != 3 || list[0].JobID != again.ID || again.ID == listing.ID || list[0].State != "queued" || list[1].ID != record {
		t.Fatalf("records after retry: %+v", list)
	}
	must(t, s.StopCollection(ctx, tenant, list[0].ID))
	if stopped, e := s.CaptureRecord(ctx, tenant, list[0].ID); e != nil || !stopped.Stopped || !stopped.Done {
		t.Fatalf("stopped record %+v %v", stopped.CaptureRecord, e)
	}

	// A record whose collection left the library can still be captured again.
	must(t, s.DeleteCollection(ctx, tenant, entry.CollectionID))
	gone, e := s.CaptureRecord(ctx, tenant, list[2].ID)
	must(t, e)
	if gone.Saved {
		t.Fatal("deleted collection still reported as saved")
	}
	if _, e = s.RetryCaptureRecord(ctx, tenant, gone.ID, ""); e != nil {
		t.Fatal(e)
	}
	if list = records(); len(list) != 4 || !list[0].Saved || list[0].CollectionID != entry.CollectionID {
		t.Fatalf("records after saving again: %+v", list)
	}
}
