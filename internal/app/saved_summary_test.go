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

type summaryFixture struct{ *relatedEdgeFixture }

func (f *summaryFixture) Fetch(ctx context.Context, r *pb.FetchRequest, opts ...grpc.CallOption) (*pb.FetchResponse, error) {
	out, err := f.relatedEdgeFixture.Fetch(ctx, r, opts...)
	if err == nil {
		out.Summary = "summary of " + r.ExternalId
	}
	return out, err
}

func TestReferencedPostReadsItsSavedSummary(t *testing.T) {
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
	var owner, other string
	must(t, admin.Pool.QueryRow(ctx, `INSERT INTO tenants DEFAULT VALUES RETURNING id`).Scan(&owner))
	must(t, admin.Pool.QueryRow(ctx, `INSERT INTO tenants DEFAULT VALUES RETURNING id`).Scan(&other))
	fixture := &summaryFixture{&relatedEdgeFixture{incomingFixture: &incomingFixture{collectionAdapter: &collectionAdapter{&fakeAdapter{}}, name: "Synthetic fixture"}}}
	service := &Service{DB: db, Queue: queue, Adapter: fixture, Config: Defaults()}
	service.Config.Rate = 1000
	capture := func(tenant, external string) string {
		t.Helper()
		job, err := service.Submit(ctx, tenant, domain.CaptureInput{URL: "https://notes.test/entry/" + external})
		must(t, err)
		must(t, service.capture(ctx, store.Task{Tenant: tenant, ID: job.ID}))
		must(t, service.finalize(ctx, tenant, job.ID))
		job, err = service.Job(ctx, tenant, job.ID)
		must(t, err)
		return job.CollectionID
	}
	quoted := "synthetic_quote_" + uuid.NewString()
	capture(owner, quoted)
	fixture.graph = &pb.EntityGraph{Root: "root", Entities: []*pb.Entity{
		{Key: "root", Type: "document.entry", DataJson: []byte(`{}`)},
		{Key: "quote", Type: "document.entry", ExternalId: quoted, DataJson: []byte(`{}`), ContextOnly: true},
	}, Relations: []*pb.EntityRelation{{Source: "root", Target: "quote", Type: "quoted"}}}
	quoting := uuid.NewString()
	summary := func(tenant, collection string) string {
		t.Helper()
		a, err := service.Collection(ctx, tenant, collection)
		must(t, err)
		for _, e := range a.Graph.Entities {
			if e.Key == "quote" {
				return e.SavedSummary
			}
		}
		t.Fatal("quote missing")
		return ""
	}
	if got := summary(owner, capture(owner, quoting)); got != "summary of "+quoted {
		t.Fatalf("saved quote summary: %q", got)
	}
	// Whoever has not saved the quoted post sees only the reference.
	if got := summary(other, capture(other, uuid.NewString())); got != "" {
		t.Fatalf("unsaved quote summary: %q", got)
	}
}
