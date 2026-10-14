package app

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "monitor/api/adapter/v1"
	"monitor/internal/channelapi"
	"monitor/internal/domain"
	"monitor/internal/store"
)

// unavailableAdapter fails the member fetches the test marks as down.
type unavailableAdapter struct {
	*datedAdapter
	down map[string]bool
}

func (f *unavailableAdapter) Fetch(ctx context.Context, r *pb.FetchRequest, o ...grpc.CallOption) (*pb.FetchResponse, error) {
	f.mu.Lock()
	down := f.down[r.ExternalId]
	f.mu.Unlock()
	if down {
		return nil, status.Error(codes.Unavailable, "provider temporarily unavailable")
	}
	return f.datedAdapter.Fetch(ctx, r, o...)
}

func TestRetryErrorKeepsUpstreamMessage(t *testing.T) {
	e := &RetryError{After: time.Second, Err: status.Error(codes.Unavailable, "provider temporarily unavailable")}
	if got := safeError(e); got != "provider temporarily unavailable" {
		t.Fatal("retry error lost the upstream message:", got)
	}
	if RetryDelay(e) != time.Second {
		t.Fatal("retry delay lost")
	}
}

func TestRefreshBatchRetry(t *testing.T) {
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
	fake := &unavailableAdapter{datedAdapter: &datedAdapter{collectionAdapter: &collectionAdapter{&fakeAdapter{}}, members: map[string]string{
		prefix + "-kept":   "",
		prefix + "-flaky":  "",
		prefix + "-gone":   "",
		prefix + "-broken": "",
	}}, down: map[string]bool{}}
	cfg := Defaults()
	cfg.Rate = 1000
	s := &Service{DB: db, Queue: queue, Adapter: fake, Config: cfg}
	var tenant string
	must(t, admin.Pool.QueryRow(ctx, "INSERT INTO tenants DEFAULT VALUES RETURNING id").Scan(&tenant))
	channel := uuid.NewString()
	_, e = admin.Pool.Exec(ctx, `INSERT INTO channels(id,kind,external_id) VALUES($1,'test',$2)`, channel, channel)
	must(t, e)
	_, e = admin.Pool.Exec(ctx, `INSERT INTO identities(tenant_id,channel_id,external_id) VALUES($1,$2,'4242')`, tenant, channel)
	must(t, e)
	setDown := func(ids ...string) {
		fake.mu.Lock()
		defer fake.mu.Unlock()
		fake.down = map[string]bool{}
		for _, id := range ids {
			fake.down[prefix+"-"+id] = true
		}
	}
	// Runs the page's related task, then every member capture it queued the way
	// the worker would: a failing fetch ends the capture with the safe message.
	members := func(page string) {
		must(t, s.related(ctx, store.Task{Tenant: tenant, ID: page, Type: "related"}))
		rows, e := admin.Pool.Query(ctx, `SELECT c.id FROM submissions s JOIN captures c ON c.id=s.capture_id WHERE s.parent_submission=$1 AND c.state='queued'`, page)
		must(t, e)
		ids, e := pgx.CollectRows(rows, pgx.RowTo[string])
		must(t, e)
		for _, id := range ids {
			task := store.Task{Tenant: tenant, ID: id, Type: "capture"}
			if e := s.capture(ctx, task); e != nil {
				must(t, s.fail(ctx, task, safeError(e)))
				continue
			}
			must(t, s.finalize(ctx, tenant, id))
		}
	}
	captures := func(name string) (n int) {
		must(t, admin.Pool.QueryRow(ctx, `SELECT count(*) FROM captures c JOIN collections a ON a.id=c.collection_id WHERE a.external_id=$1`, prefix+"-"+name).Scan(&n))
		return
	}

	first, e := s.Submit(ctx, tenant, domain.CaptureInput{URL: "https://notes.test/collection/" + prefix})
	must(t, e)
	must(t, s.capture(ctx, store.Task{Tenant: tenant, ID: first.ID}))
	must(t, s.finalize(ctx, tenant, first.ID))
	var page string
	must(t, admin.Pool.QueryRow(ctx, `SELECT id FROM submissions WHERE capture_id=$1 AND related_state='pending'`, first.ID).Scan(&page))
	members(page)

	b, e := s.StartRefreshBatch(ctx, tenant, []string{first.CollectionID}, "full", channel)
	must(t, e)
	must(t, s.refreshBatch(ctx, store.Task{Tenant: tenant, ID: b.ID, Type: "refresh_batch"}))
	progress := func() RefreshBatch {
		b, e := s.RefreshBatch(ctx, tenant, b.ID)
		must(t, e)
		return b
	}
	var listing string
	must(t, admin.Pool.QueryRow(ctx, `SELECT capture_ids[1] FROM refresh_batches WHERE id=$1`, b.ID).Scan(&listing))
	must(t, s.capture(ctx, store.Task{Tenant: tenant, ID: listing}))
	must(t, s.finalize(ctx, tenant, listing))
	must(t, admin.Pool.QueryRow(ctx, `SELECT id FROM submissions WHERE capture_id=$1 AND related_state='pending'`, listing).Scan(&page))
	if _, e = s.RetryRefreshBatch(ctx, tenant, b.ID); e != errBatchRunning {
		t.Fatal("running batch retried", e)
	}
	setDown("flaky", "gone", "broken")
	members(page)
	// The source reported one of the failed posts gone: fetching it again is pointless.
	var gone string
	must(t, admin.Pool.QueryRow(ctx, `SELECT id FROM collections WHERE external_id=$1`, prefix+"-gone").Scan(&gone))
	must(t, s.markSourceState(ctx, tenant, gone, "deleted"))
	if p := progress(); !p.Done || p.Members.Complete != 1 || p.Members.Failed != 3 || p.Retryable != 2 {
		t.Fatalf("failed batch progress %+v", p)
	}
	w, e := s.ClaimChannel(ctx, channel, "")
	must(t, e)
	if w == nil || w.Kind != "batch" || w.Resource != b.ID {
		t.Fatalf("batch work %+v", w)
	}
	must(t, s.AckChannel(ctx, channel, w.ID, channelapi.Ack{Lease: w.Lease, MessageID: 7, Done: true}))

	// Retrying fetches only the failed posts the source may still serve.
	setDown("broken")
	n, e := s.RetryRefreshBatch(ctx, tenant, b.ID)
	must(t, e)
	if n != 2 {
		t.Fatal("retried members", n)
	}
	if p := progress(); p.Done || p.Retryable != 0 || p.Members.Failed != 1 || p.Members.Complete != 1 {
		t.Fatalf("retrying batch progress %+v", p)
	}
	if n, e = s.RetryRefreshBatch(ctx, tenant, b.ID); e != errBatchRunning || n != 0 {
		t.Fatal("retry repeated while running", n, e)
	}
	// The message that reported the batch follows the retry.
	again, e := s.ClaimChannel(ctx, channel, "")
	must(t, e)
	if again == nil || again.ID != w.ID || again.MessageID != 7 {
		t.Fatalf("batch work not reopened %+v", again)
	}
	must(t, s.AckChannel(ctx, channel, again.ID, channelapi.Ack{Lease: again.Lease, MessageID: 7, Done: true}))
	members(page)
	if p := progress(); !p.Done || p.Members.Complete != 2 || p.Members.Failed != 2 || p.Retryable != 1 || p.Members.Total != 4 {
		t.Fatalf("retried batch progress %+v", p)
	}
	for name, want := range map[string]int{"kept": 2, "flaky": 3, "gone": 2, "broken": 3} {
		if got := captures(name); got != want {
			t.Fatalf("%s captured %d times, want %d", name, got, want)
		}
	}
	setDown()
	if n, e = s.RetryRefreshBatch(ctx, tenant, b.ID); e != nil || n != 1 {
		t.Fatal("second retry", n, e)
	}
	members(page)
	if p := progress(); !p.Done || p.Members.Complete != 3 || p.Members.Failed != 1 || p.Retryable != 0 {
		t.Fatalf("batch after second retry %+v", p)
	}
	if n, e = s.RetryRefreshBatch(ctx, tenant, b.ID); e != nil || n != 0 {
		t.Fatal("nothing left to retry", n, e)
	}
	var other string
	must(t, admin.Pool.QueryRow(ctx, "INSERT INTO tenants DEFAULT VALUES RETURNING id").Scan(&other))
	if _, e = s.RetryRefreshBatch(ctx, other, b.ID); e != domain.ErrNotFound {
		t.Fatal("foreign batch retried", e)
	}
}

// Two provisional identities of one object fetched at once: the second to
// learn the canonical identity joins the capture already running there.
func TestCaptureJoinsRunningCanonicalCapture(t *testing.T) {
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
	s := &Service{DB: db, Queue: queue, Adapter: &collectionAdapter{&fakeAdapter{}}, Config: cfg}
	var tenant string
	must(t, admin.Pool.QueryRow(ctx, "INSERT INTO tenants DEFAULT VALUES RETURNING id").Scan(&tenant))
	prefix := strings.ReplaceAll(uuid.NewString(), "-", "")
	canonical, e := s.Submit(ctx, tenant, domain.CaptureInput{URL: "https://notes.test/collection/" + prefix})
	must(t, e)
	alias, e := s.Submit(ctx, tenant, domain.CaptureInput{URL: "https://notes.test/collection/alias-" + prefix})
	must(t, e)
	var batch string
	must(t, admin.Pool.QueryRow(ctx, `INSERT INTO refresh_batches(tenant_id,collection_ids,update_mode,capture_ids) VALUES($1,ARRAY[$2::uuid],'full',ARRAY[$3::uuid]) RETURNING id`, tenant, alias.CollectionID, alias.ID).Scan(&batch))
	must(t, s.capture(ctx, store.Task{Tenant: tenant, ID: alias.ID}))
	var state, tracked string
	var submissions int
	must(t, admin.Pool.QueryRow(ctx, `SELECT state FROM captures WHERE id=$1`, alias.ID).Scan(&state))
	must(t, admin.Pool.QueryRow(ctx, `SELECT count(*) FROM submissions WHERE capture_id=$1`, canonical.ID).Scan(&submissions))
	must(t, admin.Pool.QueryRow(ctx, `SELECT capture_ids[1] FROM refresh_batches WHERE id=$1`, batch).Scan(&tracked))
	if state != "failed" || submissions != 2 || tracked != canonical.ID {
		t.Fatal("alias capture did not join the running one", state, submissions, tracked)
	}
	must(t, s.capture(ctx, store.Task{Tenant: tenant, ID: canonical.ID}))
	must(t, s.finalize(ctx, tenant, canonical.ID))
	var saved int
	must(t, admin.Pool.QueryRow(ctx, `SELECT count(*) FROM tenant_collections WHERE tenant_id=$1`, tenant).Scan(&saved))
	if j, e := s.Job(ctx, tenant, canonical.ID); e != nil || j.State != "complete" || saved != 1 {
		t.Fatal("canonical capture after join", j.State, e, saved)
	}
}
