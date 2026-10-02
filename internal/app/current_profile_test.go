package app

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	pb "monitor/api/adapter/v1"
	"monitor/internal/domain"
	"monitor/internal/store"
)

// profileFixture captures entries whose author can change between captures,
// and a quoting entry that carries a partial copy of another entry's author.
type profileFixture struct {
	*avatarFixture
	names map[string]string
	gone  string
}

func (f *profileFixture) Fetch(_ context.Context, r *pb.FetchRequest, opts ...grpc.CallOption) (*pb.FetchResponse, error) {
	if f.gone != "" {
		for _, o := range opts {
			if t, ok := o.(grpc.TrailerCallOption); ok {
				*t.TrailerAddr = metadata.Pairs("source-state", f.gone)
			}
		}
		return nil, status.Error(codes.FailedPrecondition, "entry is gone")
	}
	person := func(key, external, name string) *pb.Entity {
		return &pb.Entity{Key: key, Type: "directory.person", ExternalId: external, DataJson: []byte(`{"name":"` + name + `"}`), ContextOnly: true}
	}
	author := "person-" + r.ExternalId[:1]
	out := &pb.FetchResponse{ExternalId: r.ExternalId, ProviderId: r.ProviderId, Text: r.ExternalId, Visibility: pb.Visibility_VISIBILITY_PUBLIC}
	out.Graph = &pb.EntityGraph{Root: "root", Entities: []*pb.Entity{{Key: "root", Type: "document.entry", ExternalId: r.ExternalId, DataJson: []byte(`{}`)}, person("author", author, f.names[author])}, Relations: []*pb.EntityRelation{{Source: "root", Target: "author", Type: "authored_by"}}}
	if r.ExternalId == "q-quoting" {
		out.Graph.Entities = append(out.Graph.Entities, &pb.Entity{Key: "quote", Type: "document.entry", ExternalId: "a-first", DataJson: []byte(`{}`), ContextOnly: true}, person("quoted_author", "person-a", "partial"))
		out.Graph.Relations = append(out.Graph.Relations, &pb.EntityRelation{Source: "root", Target: "quote", Type: "quoted"}, &pb.EntityRelation{Source: "quote", Target: "quoted_author", Type: "authored_by"})
	}
	return out, nil
}

func TestAuthorsReadTheirCurrentVersionAndGoneSourcesAreMarked(t *testing.T) {
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
	fixture := &profileFixture{avatarFixture: &avatarFixture{collectionAdapter: &collectionAdapter{&fakeAdapter{}}}, names: map[string]string{"person-a": "first name", "person-q": "quoter"}}
	s := &Service{DB: db, Queue: queue, Adapter: fixture, Blobs: &memoryBlob{m: map[string][]byte{}}, Config: Defaults()}
	s.Config.Rate = 1000
	var tenant string
	must(t, admin.Pool.QueryRow(ctx, `INSERT INTO tenants DEFAULT VALUES RETURNING id`).Scan(&tenant))
	capture := func(in domain.CaptureInput) (domain.Job, error) {
		t.Helper()
		job, err := s.Submit(ctx, tenant, in)
		must(t, err)
		if err = s.capture(ctx, store.Task{Tenant: tenant, ID: job.ID}); err != nil {
			return job, err
		}
		must(t, s.finalize(ctx, tenant, job.ID))
		return s.Job(ctx, tenant, job.ID)
	}
	first, err := capture(domain.CaptureInput{URL: "https://notes.test/entry/a-first"})
	must(t, err)
	author := func(key string) domain.Entity {
		t.Helper()
		detail, err := s.SavedCollection(ctx, tenant, first.CollectionID)
		must(t, err)
		for _, e := range detail.Graph.Entities {
			if e.Key == key {
				return e
			}
		}
		t.Fatal("entity missing", key)
		return domain.Entity{}
	}
	if author("author").Current != nil {
		t.Fatal("an unchanged author reported a newer version")
	}
	// A partial copy of the author inside another capture is not a newer profile.
	_, err = capture(domain.CaptureInput{URL: "https://notes.test/entry/q-quoting"})
	must(t, err)
	if author("author").Current != nil {
		t.Fatal("a quoted author's partial copy replaced the profile")
	}
	// The author's own next entry is.
	fixture.names["person-a"] = "renamed"
	_, err = capture(domain.CaptureInput{URL: "https://notes.test/entry/a-second"})
	must(t, err)
	current := author("author").Current
	var data struct{ Name string }
	if current == nil || json.Unmarshal(current.Data, &data) != nil || data.Name != "renamed" {
		t.Fatal("author did not read its current version", current)
	}
	if json.Unmarshal(author("author").Data, &data); data.Name != "first name" {
		t.Fatal("the captured author snapshot changed", data)
	}

	// A refresh that finds the entry gone marks it and keeps its content.
	fixture.gone = "deleted"
	if _, err = capture(domain.CaptureInput{URL: "https://notes.test/entry/a-first", RefreshID: first.CollectionID}); err == nil {
		t.Fatal("a gone entry captured successfully")
	}
	detail, err := s.SavedCollection(ctx, tenant, first.CollectionID)
	must(t, err)
	if detail.SourceState != "deleted" || detail.SourceStateAt == nil || detail.Text != "a-first" {
		t.Fatal("gone entry not marked", detail.SourceState, detail.Text)
	}
	// It may come back, as a suspended account does.
	fixture.gone = ""
	_, err = capture(domain.CaptureInput{URL: "https://notes.test/entry/a-first", RefreshID: first.CollectionID})
	must(t, err)
	detail, err = s.SavedCollection(ctx, tenant, first.CollectionID)
	must(t, err)
	if detail.SourceState != "" || detail.SourceStateAt != nil {
		t.Fatal("a successful capture kept the gone mark", detail.SourceState)
	}
}
