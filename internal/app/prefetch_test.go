package app

import (
	"context"
	"fmt"
	"os"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"google.golang.org/grpc"

	pb "monitor/api/adapter/v1"
	"monitor/internal/adapter"
	"monitor/internal/domain"
	"monitor/internal/store"
)

type prefetchAdapter struct {
	*collectionAdapter
	mu       sync.Mutex
	received map[string]string
}

func (f *prefetchAdapter) Describe(ctx context.Context, r *pb.DescribeRequest, opts ...grpc.CallOption) (*pb.DescribeResponse, error) {
	d, e := f.collectionAdapter.Describe(ctx, r, opts...)
	if e == nil {
		p := d.Providers[0]
		p.Capabilities = append(p.Capabilities, &pb.Capability{Name: adapter.CapturePrefetch, Major: 1})
	}
	return d, e
}

func (f *prefetchAdapter) Fetch(ctx context.Context, r *pb.FetchRequest, opts ...grpc.CallOption) (*pb.FetchResponse, error) {
	out, e := f.collectionAdapter.Fetch(ctx, r, opts...)
	if e != nil {
		return nil, e
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.Kind == "entry" {
		f.received[r.ExternalId] = string(r.Prefetch)
		out.RelatedTargets = nil
	}
	for i, target := range out.RelatedTargets {
		target.Prefetch = []byte(fmt.Sprintf("listed-%d", i))
	}
	return out, nil
}

func TestRelatedPrefetchReachesMemberCaptures(t *testing.T) {
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
	fake := &prefetchAdapter{collectionAdapter: &collectionAdapter{&fakeAdapter{}}, received: map[string]string{}}
	cfg := Defaults()
	cfg.Rate = 1000
	s := &Service{DB: db, Queue: queue, Adapter: fake, Config: cfg}
	var tenant string
	must(t, admin.Pool.QueryRow(ctx, "INSERT INTO tenants DEFAULT VALUES RETURNING id").Scan(&tenant))
	job, e := s.Submit(ctx, tenant, domain.CaptureInput{URL: "https://notes.test/collection/listing"})
	must(t, e)
	must(t, s.capture(ctx, store.Task{Tenant: tenant, ID: job.ID}))
	must(t, s.finalize(ctx, tenant, job.ID))
	var sid string
	must(t, db.Tx(ctx, tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT id FROM submissions WHERE capture_id=$1 AND related_state='pending'`, job.ID).Scan(&sid)
	}))
	must(t, s.related(ctx, store.Task{Tenant: tenant, ID: sid, Type: "related"}))
	var left int
	must(t, admin.Pool.QueryRow(ctx, `SELECT count(*) FROM jsonb_array_elements((SELECT related_targets FROM captures WHERE id=$1)) t WHERE t ? 'prefetch'`, job.ID).Scan(&left))
	if left != 0 {
		t.Fatalf("parent kept %d prefetches after dispatch", left)
	}
	var member string
	must(t, admin.Pool.QueryRow(ctx, `SELECT c.id FROM captures c JOIN collections a ON a.id=c.collection_id WHERE c.tenant_id=$1 AND a.external_id='listing-3'`, tenant).Scan(&member))
	must(t, s.capture(ctx, store.Task{Tenant: tenant, ID: member}))
	if got := fake.received["listing-3"]; got != "listed-3" {
		t.Fatalf("member capture received %q", got)
	}
	var kept bool
	must(t, admin.Pool.QueryRow(ctx, `SELECT prefetch IS NOT NULL FROM captures WHERE id=$1`, member).Scan(&kept))
	if kept {
		t.Fatal("prefetch kept after the capture fetched")
	}
}
