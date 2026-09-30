package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "monitor/api/adapter/v1"
	"monitor/internal/domain"
	"monitor/internal/store"
)

func TestWebCollection(t *testing.T) {
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
	q, e := river.NewClient(riverpgxv5.New(db.Pool), &river.Config{})
	must(t, e)
	channel := uuid.NewString()
	_, e = admin.Pool.Exec(ctx, `INSERT INTO channels(id,kind,external_id) VALUES($1,'test',$2)`, channel, channel)
	must(t, e)
	a, e := db.Resolve(ctx, channel, "a", 1<<30)
	must(t, e)
	b, e := db.Resolve(ctx, channel, "b", 1<<30)
	must(t, e)
	fake := &fakeAdapter{public: true, text: "中文收藏 100%"}
	s := &Service{DB: db, Queue: q, Adapter: fake, Config: Defaults(), Blobs: &memoryBlob{m: map[string][]byte{}}}
	s.Config.Rate = 1000
	var jobs []domain.Job
	for i := 0; i < 22; i++ {
		j, e := s.Submit(ctx, a.TenantID, domain.CaptureInput{URL: fmt.Sprintf("https://x.com/a/status/%d", time.Now().UnixNano())})
		must(t, e)
		must(t, s.capture(ctx, store.Task{Tenant: a.TenantID, ID: j.ID}))
		must(t, s.finalize(ctx, a.TenantID, j.ID))
		jobs = append(jobs, j)
	}
	// Both graphs contain a profile; only the graph root determines the filter.
	for i, kind := range []string{"x.post", "x.profile"} {
		_, e = admin.Pool.Exec(ctx, `UPDATE revisions SET payload=payload || jsonb_build_object('graph', jsonb_build_object('root','root','entities',jsonb_build_array(jsonb_build_object('key','root','type',$2::text),jsonb_build_object('key','author','type','x.profile')))) WHERE collection_id=$1`, jobs[i].CollectionID, kind)
		must(t, e)
	}
	for _, kind := range []string{"x.post", "x.profile"} {
		filtered, err := s.Collections(ctx, a.TenantID, CollectionFilter{EntityType: kind}, "")
		must(t, err)
		if len(filtered.Items) != 1 {
			t.Fatalf("%s: got %d items", kind, len(filtered.Items))
		}
	}
	if _, err := s.Collections(ctx, a.TenantID, CollectionFilter{EntityType: "invalid type"}, ""); !errors.Is(err, ErrInvalidFilter) {
		t.Fatal(err)
	}
	page, e := s.Collections(ctx, a.TenantID, CollectionFilter{Q: "中文", Media: "text", Visibility: "public"}, "")
	must(t, e)
	if len(page.Items) != 20 || page.Next == "" {
		t.Fatal(page)
	}
	must(t, s.DeleteCollection(ctx, a.TenantID, page.Items[19].ID))
	tail, e := s.Collections(ctx, a.TenantID, CollectionFilter{Q: "中文", Media: "text", Visibility: "public"}, page.Next)
	must(t, e)
	if len(tail.Items) != 2 {
		t.Fatal(tail)
	}
	if _, e = s.Collections(ctx, a.TenantID, CollectionFilter{Q: "changed"}, page.Next); e == nil {
		t.Fatal("foreign query cursor")
	}
	empty, e := s.Collections(ctx, b.TenantID, CollectionFilter{}, "")
	must(t, e)
	if len(empty.Items) != 0 {
		t.Fatal("foreign saves exposed")
	}
	literal, e := s.Collections(ctx, a.TenantID, CollectionFilter{Q: "100%"}, "")
	must(t, e)
	if len(literal.Items) == 0 {
		t.Fatal("literal wildcard search failed")
	}
	empty, e = s.Collections(ctx, a.TenantID, CollectionFilter{From: time.Now().Add(time.Hour).Format(time.RFC3339)}, "")
	must(t, e)
	if len(empty.Items) != 0 {
		t.Fatal("date ignored")
	}
	// Published order reverses capture order; ties use IDs and invalid dates fall back.
	for i, job := range jobs {
		_, e = admin.Pool.Exec(ctx, `UPDATE revisions SET payload=jsonb_set(payload,'{published_at}',to_jsonb($2::text)) WHERE id=(SELECT current_revision FROM collections WHERE id=$1)`, job.CollectionID, time.Date(2026, 1, 22-i, 0, 0, 0, 0, time.UTC).Format(time.RFC3339))
		must(t, e)
	}
	published, e := s.Collections(ctx, a.TenantID, CollectionFilter{Sort: "published"}, "")
	must(t, e)
	if len(published.Items) != 20 || published.Next == "" || published.Items[0].ID != jobs[0].CollectionID {
		t.Fatal(published)
	}
	publishedTail, e := s.Collections(ctx, a.TenantID, CollectionFilter{Sort: "published"}, published.Next)
	must(t, e)
	if len(publishedTail.Items) != 1 || publishedTail.Next != "" {
		t.Fatal(publishedTail)
	}
	ascending, e := s.Collections(ctx, a.TenantID, CollectionFilter{Sort: "published", Order: "asc"}, "")
	must(t, e)
	if len(ascending.Items) != 20 || ascending.Items[0].ID != jobs[21].CollectionID {
		t.Fatal(ascending)
	}
	ascendingTail, e := s.Collections(ctx, a.TenantID, CollectionFilter{Sort: "published", Order: "asc"}, ascending.Next)
	must(t, e)
	if len(ascendingTail.Items) != 1 || ascendingTail.Items[0].ID != jobs[0].CollectionID || ascendingTail.Next != "" {
		t.Fatal(ascendingTail)
	}
	if _, e = s.Collections(ctx, a.TenantID, CollectionFilter{Sort: "published", Order: "asc"}, published.Next); e == nil {
		t.Fatal("cursor accepted for a different direction")
	}
	if _, e = s.Collections(ctx, a.TenantID, CollectionFilter{Sort: "captured"}, published.Next); e == nil {
		t.Fatal("cursor accepted for a different sort")
	}
	if _, e = s.Collections(ctx, a.TenantID, CollectionFilter{Sort: "invalid"}, ""); !errors.Is(e, ErrInvalidFilter) {
		t.Fatal("invalid sort accepted")
	}
	_, e = admin.Pool.Exec(ctx, `UPDATE revisions SET payload=jsonb_set(payload,'{published_at}','"invalid"'::jsonb) WHERE id=(SELECT current_revision FROM collections WHERE id=$1)`, jobs[0].CollectionID)
	must(t, e)
	fallback, e := s.Collections(ctx, a.TenantID, CollectionFilter{Sort: "published"}, "")
	must(t, e)
	if fallback.Items[0].ID != jobs[0].CollectionID {
		t.Fatal("invalid publication date did not fall back to capture time")
	}
	id := jobs[0].CollectionID
	// Use a retained item in case the pagination anchor happened to be this collection.
	id = page.Items[0].ID
	if !errors.Is(s.WebAccess(ctx, b.TenantID, "collections", id), domain.ErrNotFound) {
		t.Fatal("public non-save exposed")
	}
	versions, e := s.Revisions(ctx, a.TenantID, id, "")
	must(t, e)
	if len(versions.Items) != 1 {
		t.Fatal(versions)
	}
	snapshot, e := s.Revision(ctx, a.TenantID, id, versions.Items[0].ID)
	must(t, e)
	if snapshot.Text != "中文收藏 100%" {
		t.Fatal(snapshot)
	}
	if _, e = s.Revision(ctx, b.TenantID, id, versions.Items[0].ID); !errors.Is(e, domain.ErrNotFound) {
		t.Fatal(e)
	}
	fake.set("新版本")
	job, e := s.Submit(ctx, a.TenantID, domain.CaptureInput{RefreshID: id})
	must(t, e)
	must(t, s.capture(ctx, store.Task{Tenant: a.TenantID, ID: job.ID}))
	must(t, s.finalize(ctx, a.TenantID, job.ID))
	snapshot, e = s.Revision(ctx, a.TenantID, id, versions.Items[0].ID)
	must(t, e)
	if snapshot.Text != "中文收藏 100%" {
		t.Fatal("history overwritten")
	}
	must(t, s.DeleteCollection(ctx, a.TenantID, id))
	if _, e = s.Revision(ctx, a.TenantID, id, versions.Items[0].ID); !errors.Is(e, domain.ErrNotFound) {
		t.Fatal(e)
	}
}

type registryFixture struct {
	*fakeAdapter
	mu      sync.Mutex
	offline bool
}

func (f *registryFixture) Describe(ctx context.Context, r *pb.DescribeRequest, o ...grpc.CallOption) (*pb.DescribeResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.offline {
		return nil, status.Error(codes.Unavailable, "offline")
	}
	return f.fakeAdapter.Describe(ctx, r, o...)
}

func TestAdapterRegistryRecovery(t *testing.T) {
	ctx := context.Background()
	f := &registryFixture{fakeAdapter: &fakeAdapter{}, offline: true}
	r := NewAdapterRegistry([]AdapterEndpoint{{Client: f}})
	s := &Service{Registry: r}
	must(t, r.Refresh(ctx))
	if _, e := s.forAdapter("fixture"); !errors.Is(e, ErrAdapterUnavailable) {
		t.Fatal(e)
	}
	f.offline = false
	must(t, r.Refresh(ctx))
	if _, e := s.forAdapter("fixture"); e != nil {
		t.Fatal(e)
	}
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for range 1000 {
			_ = s.adapterBindings()
			_, _ = s.forAdapter("fixture")
		}
	}()
	f.mu.Lock()
	f.offline = true
	f.mu.Unlock()
	must(t, r.Refresh(ctx))
	wg.Wait()
	if len(r.snapshot()) != 1 {
		t.Fatal("lost descriptor for saved source")
	}
	if r.available["fixture"] {
		t.Fatal("offline adapter marked available")
	}
}
