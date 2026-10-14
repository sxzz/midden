package app

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	pb "monitor/api/adapter/v1"
	"monitor/internal/domain"
	"monitor/internal/store"
)

func TestCountsChangeWithoutNewVersions(t *testing.T) {
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
	schema := []byte(`{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}`)
	post := func(likes int) *pb.EntityGraph {
		return &pb.EntityGraph{Root: "post", Entities: []*pb.Entity{{Key: "post", Type: "x.post", DataJson: []byte(`{"text":"same","likes":` + jsonInt(likes) + `}`)}}}
	}
	fake := &fakeAdapter{public: true, text: "same", graph: post(1), entityTypes: []*pb.EntityType{{Name: "x.post", JsonSchema: schema}}}
	newService := func() *Service {
		s := &Service{DB: db, Queue: queue, Adapter: fake, Config: Defaults()}
		s.Config.Rate = 1000
		return s
	}
	s := newService()
	capture := func() domain.Job {
		t.Helper()
		// A stale observation makes the automatic capture fetch again.
		_, err := admin.Pool.Exec(ctx, `UPDATE collections SET observed_at=now()-interval '1 hour' WHERE external_id='99230011'`)
		must(t, err)
		job, err := s.Submit(ctx, tenant, domain.CaptureInput{URL: "https://x.com/a/status/99230011", Automatic: true, RefreshAfterSeconds: 60})
		must(t, err)
		must(t, s.capture(ctx, store.Task{Tenant: tenant, ID: job.ID}))
		must(t, s.finalize(ctx, tenant, job.ID))
		return job
	}
	// A version saved before counts were declared keeps them in its data.
	legacy := capture()
	fake.entityTypes[0].MetricPaths = []string{"/likes"}
	s = newService()
	fake.graph = post(2)
	second := capture()
	fake.graph = post(3)
	capture()
	var versions int
	must(t, admin.Pool.QueryRow(ctx, `SELECT count(*) FROM revisions WHERE collection_id=$1`, legacy.CollectionID).Scan(&versions))
	if versions != 1 {
		t.Fatalf("counts alone made %d versions", versions)
	}
	likes := func(a domain.Collection) string {
		t.Helper()
		var data map[string]json.RawMessage
		must(t, json.Unmarshal(a.Graph.Entities[0].Data, &data))
		return string(data["likes"])
	}
	head, err := s.Collection(ctx, tenant, legacy.CollectionID)
	must(t, err)
	if likes(head) != "3" {
		t.Fatalf("collection shows likes %s, want the newest 3", likes(head))
	}
	pinned, err := s.CaptureCollection(ctx, tenant, second.ID)
	must(t, err)
	if likes(pinned) != "2" {
		t.Fatalf("capture shows likes %s, want its own 2", likes(pinned))
	}
	// Content still makes a version, without the counts in it.
	fake.graph = post(4)
	fake.graph.Entities[0].DataJson = []byte(`{"text":"edited","likes":4}`)
	capture()
	var payload []byte
	must(t, admin.Pool.QueryRow(ctx, `SELECT payload->'graph'->'entities'->0->'data' FROM revisions WHERE collection_id=$1 ORDER BY created_at DESC LIMIT 1`, legacy.CollectionID).Scan(&payload))
	if string(payload) != `{"text": "edited"}` {
		t.Fatalf("new version kept counts: %s", payload)
	}
}

func jsonInt(n int) string { b, _ := json.Marshal(n); return string(b) }

func TestRenumberedEntitiesMakeNoNewVersion(t *testing.T) {
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
	schema := []byte(`{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}`)
	// The same mentions, numbered in another order.
	graph := func(first, second string) *pb.EntityGraph {
		return &pb.EntityGraph{Root: "post", Entities: []*pb.Entity{
			{Key: "post", Type: "x.post", DataJson: []byte(`{"text":"same"}`)},
			{Key: "profile_1", Type: "x.profile", ExternalId: first, DataJson: []byte(`{}`), ContextOnly: true},
			{Key: "profile_2", Type: "x.profile", ExternalId: second, DataJson: []byte(`{}`), ContextOnly: true},
		}, Relations: []*pb.EntityRelation{{Source: "post", Target: "profile_1", Type: "mentions"}, {Source: "post", Target: "profile_2", Type: "mentions"}}}
	}
	fake := &fakeAdapter{public: true, text: "same", graph: graph("alice", "bob"), entityTypes: []*pb.EntityType{{Name: "x.post", JsonSchema: schema}, {Name: "x.profile", JsonSchema: schema}}}
	s := &Service{DB: db, Queue: queue, Adapter: fake, Config: Defaults()}
	s.Config.Rate = 1000
	capture := func() domain.Job {
		t.Helper()
		_, err := admin.Pool.Exec(ctx, `UPDATE collections SET observed_at=now()-interval '1 hour' WHERE external_id='99250011'`)
		must(t, err)
		job, err := s.Submit(ctx, tenant, domain.CaptureInput{URL: "https://x.com/a/status/99250011", Automatic: true, RefreshAfterSeconds: 60})
		must(t, err)
		must(t, s.capture(ctx, store.Task{Tenant: tenant, ID: job.ID}))
		must(t, s.finalize(ctx, tenant, job.ID))
		return job
	}
	first := capture()
	fake.graph = graph("bob", "alice")
	capture()
	var versions int
	must(t, admin.Pool.QueryRow(ctx, `SELECT count(*) FROM revisions WHERE collection_id=$1`, first.CollectionID).Scan(&versions))
	if versions != 1 {
		t.Fatalf("renumbered entities made %d versions", versions)
	}
}
