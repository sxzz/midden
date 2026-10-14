package app

import (
	"context"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"google.golang.org/grpc"

	pb "monitor/api/adapter/v1"
	"monitor/internal/domain"
	"monitor/internal/store"
)

func TestCaptureTargetOptions(t *testing.T) {
	cases := []struct {
		name    string
		options domain.CaptureOptions
		target  pb.RelatedTarget
		want    bool
	}{
		{name: "defaults keep text", want: true},
		{name: "media excludes text", options: domain.CaptureOptions{MediaOnly: true}},
		{name: "media keeps video", options: domain.CaptureOptions{MediaOnly: true}, target: pb.RelatedTarget{MediaTypes: []string{"video"}}, want: true},
		{name: "exclude quote", options: domain.CaptureOptions{OmitShared: true}, target: pb.RelatedTarget{PostType: "quote"}},
		{name: "exclude repost", options: domain.CaptureOptions{OmitShared: true}, target: pb.RelatedTarget{PostType: "repost"}},
		{name: "repost stays external", options: domain.CaptureOptions{SkipReferences: true}, target: pb.RelatedTarget{PostType: "repost"}},
		{name: "quote own content retained", options: domain.CaptureOptions{SkipReferences: true}, target: pb.RelatedTarget{PostType: "quote"}, want: true},
		{name: "old post", options: domain.CaptureOptions{Since: "2026-10-01T00:00:00Z"}, target: pb.RelatedTarget{PublishedAt: "2026-09-01T00:00:00Z"}},
		{name: "cutoff inclusive", options: domain.CaptureOptions{Since: "2026-10-01T00:00:00Z"}, target: pb.RelatedTarget{PublishedAt: "2026-10-01T00:00:00Z"}, want: true},
		{name: "unknown date", options: domain.CaptureOptions{Since: "2026-10-01T00:00:00Z"}},
	}
	for i := range cases {
		tc := &cases[i]
		t.Run(tc.name, func(t *testing.T) {
			if got := captureTargetMatches(&tc.options, &tc.target); got != tc.want {
				t.Fatalf("got %v", got)
			}
		})
	}
}

type filteredPageAdapter struct{ *pageAdapter }

func (f *filteredPageAdapter) Fetch(ctx context.Context, req *pb.FetchRequest, opts ...grpc.CallOption) (*pb.FetchResponse, error) {
	out, err := f.pageAdapter.Fetch(ctx, req, opts...)
	if err == nil && req.Kind == "collection" && !req.Automatic {
		out.RelatedTargets = nil
		for i := range 3 {
			target := &pb.RelatedTarget{Url: "https://notes.test/entry/" + req.ExternalId + "-" + req.PageCursor + string(rune('a'+i)), PostType: "post", PublishedAt: "2026-10-10T00:00:00Z"}
			if req.PageCursor != "" {
				target.MediaTypes = []string{"image"}
			}
			out.RelatedTargets = append(out.RelatedTargets, target)
		}
	}
	return out, err
}

func TestCaptureOptionsContinueEmptyPageAndBoundFinalPage(t *testing.T) {
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
	queue, err := river.NewClient(riverpgxv5.New(db.Pool), &river.Config{})
	must(t, err)
	var tenant string
	must(t, admin.Pool.QueryRow(ctx, `INSERT INTO tenants DEFAULT VALUES RETURNING id`).Scan(&tenant))
	s := &Service{DB: db, Queue: queue, Adapter: &filteredPageAdapter{&pageAdapter{&collectionAdapter{&fakeAdapter{}}}}, Config: Defaults()}
	s.Config.Rate = 1000
	job, err := s.Submit(ctx, tenant, domain.CaptureInput{URL: "https://notes.test/collection/" + uuid.NewString(), Options: &domain.CaptureOptions{MediaOnly: true, MaxPosts: 2}})
	must(t, err)
	for page := 0; page < 2; page++ {
		must(t, s.capture(ctx, store.Task{Tenant: tenant, ID: job.ID}))
		must(t, s.finalize(ctx, tenant, job.ID))
		var sid string
		must(t, admin.Pool.QueryRow(ctx, `SELECT id FROM submissions WHERE capture_id=$1 AND tenant_id=$2`, job.ID, tenant).Scan(&sid))
		must(t, s.related(ctx, store.Task{Tenant: tenant, ID: sid}))
		must(t, s.related(ctx, store.Task{Tenant: tenant, ID: sid}))
		var count int
		must(t, admin.Pool.QueryRow(ctx, `SELECT count(*) FROM tenant_collections tc JOIN collections c ON c.id=tc.collection_id WHERE tc.tenant_id=$1 AND c.kind='entry'`, tenant).Scan(&count))
		if page == 0 {
			if count != 0 {
				t.Fatalf("text page saved %d entries", count)
			}
			must(t, admin.Pool.QueryRow(ctx, `SELECT child.capture_id FROM submissions parent JOIN submissions child ON child.id=parent.next_submission WHERE parent.id=$1`, sid).Scan(&job.ID))
		} else if count != 2 {
			t.Fatalf("final page saved %d entries, want 2", count)
		}
	}
}
