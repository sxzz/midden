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

	// A failed member is fetched again inside the same record, not as a new one.
	if detail.Retryable != 1 {
		t.Fatal("retryable members", detail.Retryable)
	}
	if n, e := s.RetryCaptureMembers(ctx, other, record, ""); !errors.Is(e, domain.ErrNotFound) || n != 0 {
		t.Fatal("foreign member retry permitted", n, e)
	}
	n, e := s.RetryCaptureMembers(ctx, tenant, record, members[1])
	must(t, e)
	if n != 1 {
		t.Fatal("retried members", n)
	}
	if r, e := s.CaptureRecord(ctx, tenant, record); e != nil || r.Done || r.Retryable != 0 {
		t.Fatalf("record after member retry %+v %v", r.CaptureRecord, e)
	}
	must(t, s.related(ctx, store.Task{Tenant: tenant, ID: record, Type: "related"}))
	var retried string
	must(t, admin.Pool.QueryRow(ctx, `SELECT capture_id FROM submissions WHERE parent_submission=$1 AND idem_key LIKE 'related:%' AND capture_id<>ALL($2::uuid[])`, record, members).Scan(&retried))
	complete(retried)
	detail, e = s.CaptureRecord(ctx, tenant, record)
	must(t, e)
	if m := detail.Members; !detail.Done || m.Complete != 2 || m.Failed != 0 || m.Total != 2 {
		t.Fatalf("record after the retried member finished %+v", m)
	}
	if list = records(); len(list) != 2 {
		t.Fatalf("member retry added a record: %+v", list)
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

func TestCaptureRecordPages(t *testing.T) {
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
	cfg := Defaults()
	cfg.Rate = 1000
	s := &Service{DB: db, Queue: queue, Adapter: &pageAdapter{&collectionAdapter{&fakeAdapter{}}}, Config: cfg}
	var tenant, other string
	must(t, admin.Pool.QueryRow(ctx, "INSERT INTO tenants DEFAULT VALUES RETURNING id").Scan(&tenant))
	must(t, admin.Pool.QueryRow(ctx, "INSERT INTO tenants DEFAULT VALUES RETURNING id").Scan(&other))
	complete := func(id string) {
		must(t, s.capture(ctx, store.Task{Tenant: tenant, ID: id}))
		must(t, s.finalize(ctx, tenant, id))
	}
	// Runs a page record to its end: the listing, then its one member.
	finish := func(job domain.Job) CaptureRecordDetail {
		complete(job.ID)
		var record string
		must(t, db.Tx(ctx, tenant, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `SELECT id FROM submissions WHERE capture_id=$1 AND parent_submission IS NULL ORDER BY created_at DESC LIMIT 1`, job.ID).Scan(&record)
		}))
		must(t, s.related(ctx, store.Task{Tenant: tenant, ID: record, Type: "related"}))
		var member string
		must(t, admin.Pool.QueryRow(ctx, `SELECT capture_id FROM submissions WHERE parent_submission=$1`, record).Scan(&member))
		complete(member)
		d, e := s.CaptureRecord(ctx, tenant, record)
		must(t, e)
		return d
	}

	job, e := s.CaptureURL(ctx, tenant, "https://notes.test/collection/"+uuid.NewString(), "")
	must(t, e)
	first := finish(job)
	if p := first.Pages; !first.Done || p == nil || !p.More || !p.More1000 || p.Failed {
		t.Fatalf("first page record %+v %+v", first.CaptureRecord, p)
	}
	if _, e = s.CaptureRecordPage(ctx, other, first.ID, "more", ""); !errors.Is(e, domain.ErrNotFound) {
		t.Fatal("foreign record continued", e)
	}
	more, e := s.CaptureRecordPage(ctx, tenant, first.ID, "more", "")
	must(t, e)
	// Asking twice gives the same page, as pressing the bot's button twice does.
	if again, e := s.CaptureRecordPage(ctx, tenant, first.ID, "more", ""); e != nil || again.ID != more.ID {
		t.Fatal("second request fetched another page", again.ID, more.ID, e)
	}
	second := finish(more)
	records, e := s.CaptureRecords(ctx, tenant, "")
	must(t, e)
	if len(records.Items) != 2 || records.Items[0].ID != second.ID || records.Items[1].ID != first.ID {
		t.Fatalf("the next page is not its own record: %+v", records.Items)
	}
	if p := second.Pages; p == nil || p.More || p.More1000 {
		t.Fatalf("last page still offers more: %+v", p)
	}
	if _, e = s.CaptureRecordPage(ctx, tenant, second.ID, "more", ""); !errors.Is(e, ErrNoMorePages) {
		t.Fatal("fetched past the last page", e)
	}
	// Retrying a page fetches the same cursor again.
	retried, e := s.CaptureRecordPage(ctx, tenant, second.ID, "page_retry", "fixture")
	must(t, e)
	var cursor string
	must(t, admin.Pool.QueryRow(ctx, `SELECT page_cursor FROM captures WHERE id=$1`, retried.ID).Scan(&cursor))
	if cursor != "second" {
		t.Fatal("page retry fetched another page", cursor)
	}
	// Only the bot's three operations exist.
	if _, e = s.CaptureRecordPage(ctx, tenant, records.Items[0].ID, "unknown", ""); !errors.Is(e, domain.ErrUnsupported) {
		t.Fatal("accepted an unknown operation", e)
	}
}
