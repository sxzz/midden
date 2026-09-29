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
	for i := 0; i < 12; i++ {
		j, e := s.Submit(ctx, a.TenantID, domain.CaptureInput{URL: fmt.Sprintf("https://x.com/a/status/%d", time.Now().UnixNano())})
		must(t, e)
		must(t, s.capture(ctx, store.Task{Tenant: a.TenantID, ID: j.ID}))
		must(t, s.finalize(ctx, a.TenantID, j.ID))
		jobs = append(jobs, j)
	}
	page, e := s.Collections(ctx, a.TenantID, CollectionFilter{Q: "中文", Media: "text", Visibility: "public"}, "")
	must(t, e)
	if len(page.Items) != 10 || page.Next == "" {
		t.Fatal(page)
	}
	must(t, s.DeleteCollection(ctx, a.TenantID, page.Items[9].ID))
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
