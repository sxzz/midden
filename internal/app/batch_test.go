package app

import (
	"context"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"google.golang.org/grpc"

	pb "monitor/api/adapter/v1"
	"monitor/internal/domain"
	"monitor/internal/store"
)

// datedAdapter lists collection members with the change times the test sets.
type datedAdapter struct {
	*collectionAdapter
	mu      sync.Mutex
	members map[string]string
}

func (f *datedAdapter) Resolve(ctx context.Context, r *pb.ResolveRequest, o ...grpc.CallOption) (*pb.ResolveResponse, error) {
	d, e := f.collectionAdapter.Resolve(ctx, r, o...)
	if e == nil {
		d.Collection = d.Kind == "collection"
	}
	return d, e
}

func (f *datedAdapter) Fetch(ctx context.Context, r *pb.FetchRequest, o ...grpc.CallOption) (*pb.FetchResponse, error) {
	out, e := f.collectionAdapter.Fetch(ctx, r, o...)
	if e != nil {
		return out, e
	}
	if r.Kind == "collection" && !r.Automatic {
		f.mu.Lock()
		defer f.mu.Unlock()
		out.RelatedTargets = nil
		for id, updated := range f.members {
			out.RelatedTargets = append(out.RelatedTargets, &pb.RelatedTarget{Url: "https://notes.test/entry/" + id, UpdatedAt: updated})
		}
	} else {
		out.RelatedTargets = nil
	}
	return out, nil
}

func TestRefreshBatchModes(t *testing.T) {
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
	past := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)
	fake := &datedAdapter{collectionAdapter: &collectionAdapter{&fakeAdapter{}}, members: map[string]string{
		prefix + "-kept":    past,
		prefix + "-edited":  past,
		prefix + "-undated": "",
	}}
	cfg := Defaults()
	cfg.Rate = 1000
	s := &Service{DB: db, Queue: queue, Adapter: fake, Config: cfg}
	var tenant string
	must(t, admin.Pool.QueryRow(ctx, "INSERT INTO tenants DEFAULT VALUES RETURNING id").Scan(&tenant))
	complete := func(id string) {
		must(t, s.capture(ctx, store.Task{Tenant: tenant, ID: id}))
		must(t, s.finalize(ctx, tenant, id))
	}
	// Completes the collection capture and every member capture it queued.
	expand := func(capture string) {
		complete(capture)
		var sid string
		must(t, db.Tx(ctx, tenant, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `SELECT id FROM submissions WHERE capture_id=$1 AND related_state='pending' ORDER BY created_at DESC LIMIT 1`, capture).Scan(&sid)
		}))
		must(t, s.related(ctx, store.Task{Tenant: tenant, ID: sid, Type: "related"}))
		rows, e := admin.Pool.Query(ctx, `SELECT c.id FROM submissions s JOIN captures c ON c.id=s.capture_id WHERE s.parent_submission=$1 AND c.state='queued'`, sid)
		must(t, e)
		ids, e := pgx.CollectRows(rows, pgx.RowTo[string])
		must(t, e)
		for _, id := range ids {
			complete(id)
		}
	}
	captures := func(external string) (n int) {
		must(t, admin.Pool.QueryRow(ctx, `SELECT count(*) FROM captures c JOIN collections a ON a.id=c.collection_id WHERE a.external_id=$1`, external).Scan(&n))
		return
	}
	runBatch := func(ids []string, mode string) RefreshBatch {
		b, e := s.StartRefreshBatch(ctx, tenant, ids, mode)
		must(t, e)
		must(t, s.refreshBatch(ctx, store.Task{Tenant: tenant, ID: b.ID, Type: "refresh_batch"}))
		b, e = s.RefreshBatch(ctx, tenant, b.ID)
		must(t, e)
		return b
	}

	first, e := s.Submit(ctx, tenant, domain.CaptureInput{URL: "https://notes.test/collection/" + prefix})
	must(t, e)
	expand(first.ID)
	for id := range fake.members {
		if captures(id) != 1 {
			t.Fatal("member not captured", id)
		}
	}

	// Appending refreshes the listing, reuses unchanged members, refetches the
	// edited one and adds the new one.
	fake.mu.Lock()
	fake.members[prefix+"-edited"] = time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	fake.members[prefix+"-new"] = time.Now().UTC().Format(time.RFC3339)
	fake.mu.Unlock()
	b := runBatch([]string{first.CollectionID}, "append")
	if b.State != "complete" || b.Total != 1 || b.Submitted != 1 || b.Reused != 0 || b.Running != 1 {
		t.Fatalf("append batch progress %+v", b)
	}
	var listing string
	must(t, admin.Pool.QueryRow(ctx, `SELECT capture_ids[1] FROM refresh_batches WHERE id=$1`, b.ID).Scan(&listing))
	expand(listing)
	for id, want := range map[string]int{prefix + "-kept": 1, prefix + "-undated": 1, prefix + "-edited": 2, prefix + "-new": 1} {
		if got := captures(id); got != want {
			t.Fatalf("%s captured %d times, want %d", id, got, want)
		}
	}

	// A full refresh captures every member again.
	b = runBatch([]string{first.CollectionID}, "full")
	must(t, admin.Pool.QueryRow(ctx, `SELECT capture_ids[1] FROM refresh_batches WHERE id=$1`, b.ID).Scan(&listing))
	expand(listing)
	if got := captures(prefix + "-kept"); got != 2 {
		t.Fatal("full refresh skipped a member", got)
	}

	// Single saved entries: appending reuses complete content, full refetches it,
	// and collections deleted meanwhile are skipped without failing the batch.
	var kept, gone string
	must(t, admin.Pool.QueryRow(ctx, `SELECT id FROM collections WHERE external_id=$1`, prefix+"-kept").Scan(&kept))
	must(t, admin.Pool.QueryRow(ctx, `SELECT id FROM collections WHERE external_id=$1`, prefix+"-new").Scan(&gone))
	b, e = s.StartRefreshBatch(ctx, tenant, []string{kept, gone, kept}, "append")
	must(t, e)
	if b.Total != 2 {
		t.Fatal("duplicate ids not merged", b.Total)
	}
	must(t, s.DeleteCollection(ctx, tenant, gone))
	must(t, s.refreshBatch(ctx, store.Task{Tenant: tenant, ID: b.ID, Type: "refresh_batch"}))
	b, e = s.RefreshBatch(ctx, tenant, b.ID)
	must(t, e)
	if b.State != "complete" || b.Submitted != 2 || b.Reused != 1 || b.Rejected != 1 || b.Complete != 1 {
		t.Fatalf("append entry batch %+v", b)
	}
	if got := captures(prefix + "-kept"); got != 2 {
		t.Fatal("append refetched unchanged entry", got)
	}
	b = runBatch([]string{kept}, "full")
	if b.Reused != 0 || b.Running != 1 || captures(prefix+"-kept") != 3 {
		t.Fatalf("full entry batch %+v", b)
	}
	// Replaying a finished batch submits nothing more.
	must(t, s.refreshBatch(ctx, store.Task{Tenant: tenant, ID: b.ID, Type: "refresh_batch"}))
	if got := captures(prefix + "-kept"); got != 3 {
		t.Fatal("replayed batch submitted again", got)
	}

	// Batches only accept the tenant's own saved collections.
	var other string
	must(t, admin.Pool.QueryRow(ctx, "INSERT INTO tenants DEFAULT VALUES RETURNING id").Scan(&other))
	if _, e = s.StartRefreshBatch(ctx, other, []string{kept}, "append"); e != domain.ErrNotFound {
		t.Fatal("foreign collection accepted", e)
	}
	if _, e = s.RefreshBatch(ctx, other, b.ID); e != domain.ErrNotFound {
		t.Fatal("foreign batch readable", e)
	}
	if _, e = s.StartRefreshBatch(ctx, tenant, []string{kept}, "merge"); e != domain.ErrUnsupported {
		t.Fatal("unknown mode accepted", e)
	}
	if _, e = s.StartRefreshBatch(ctx, tenant, nil, "full"); e != domain.ErrUnsupported {
		t.Fatal("empty batch accepted", e)
	}
}
