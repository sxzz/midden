package app

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"google.golang.org/grpc"

	pb "monitor/api/adapter/v1"
	"monitor/internal/adapter"
	"monitor/internal/domain"
	"monitor/internal/store"
)

type incomingFixture struct {
	*collectionAdapter
	target, relation, name string
	author                 string
	private                bool
}

func (f *incomingFixture) Describe(ctx context.Context, r *pb.DescribeRequest, opts ...grpc.CallOption) (*pb.DescribeResponse, error) {
	out, err := f.collectionAdapter.Describe(ctx, r, opts...)
	if err != nil {
		return nil, err
	}
	if f.private {
		out.Providers[0].Visibilities = []pb.Visibility{pb.Visibility_VISIBILITY_PRIVATE}
	}
	out.Providers[0].Capabilities = append(out.Providers[0].Capabilities, &pb.Capability{Name: adapter.EntityGraph, Major: 1})
	for _, name := range []string{"directory.person", "document.entry"} {
		out.EntityTypes = append(out.EntityTypes, &pb.EntityType{Name: name, JsonSchema: []byte(`{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}`)})
		out.Providers[0].EntityTypes = append(out.Providers[0].EntityTypes, name)
	}
	return out, nil
}

func (f *incomingFixture) Fetch(_ context.Context, r *pb.FetchRequest, _ ...grpc.CallOption) (*pb.FetchResponse, error) {
	data, _ := json.Marshal(map[string]string{"name": f.name})
	root := &pb.Entity{Key: "root", Type: "document.entry", ExternalId: r.ExternalId, DataJson: data}
	if r.Kind == "collection" {
		root.Type = "directory.person"
	}
	out := &pb.FetchResponse{ExternalId: r.ExternalId, ProviderId: r.ProviderId, Text: f.name, Visibility: pb.Visibility_VISIBILITY_PUBLIC, Graph: &pb.EntityGraph{Root: "root", Entities: []*pb.Entity{root}}}
	if f.private {
		out.Visibility = pb.Visibility_VISIBILITY_PRIVATE
	}
	if f.relation != "" {
		out.Graph.Entities = append(out.Graph.Entities, &pb.Entity{Key: "target", Type: "document.entry", ExternalId: f.target, DataJson: []byte(`{}`), ContextOnly: true})
		out.Graph.Relations = []*pb.EntityRelation{{Source: "root", Target: "target", Type: f.relation}}
	}
	if f.author != "" && root.Type == "document.entry" {
		out.Graph.Entities = append(out.Graph.Entities, &pb.Entity{Key: "author", Type: "directory.person", ExternalId: f.author, DataJson: []byte(`{"name":"Synthetic quote author","username":"fixture_author"}`), ContextOnly: true})
		out.Graph.Relations = append(out.Graph.Relations, &pb.EntityRelation{Source: "root", Target: "author", Type: "authored_by"})
	}
	return out, nil
}

func TestIncomingRelationsUseSavedHistoryAndIsolateSources(t *testing.T) {
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
	fixture := &incomingFixture{collectionAdapter: &collectionAdapter{&fakeAdapter{}}, target: uuid.NewString(), name: "Synthetic target"}
	s := &Service{DB: db, Queue: queue, Adapter: fixture, Config: Defaults()}
	s.Config.Rate = 1000
	finish := func(tenant, kind, external string) domain.Collection {
		t.Helper()
		job, err := s.Submit(ctx, tenant, domain.CaptureInput{URL: "https://notes.test/" + kind + "/" + external})
		must(t, err)
		var captureTenant string
		must(t, admin.Pool.QueryRow(ctx, `SELECT tenant_id FROM captures WHERE id=$1`, job.ID).Scan(&captureTenant))
		must(t, s.capture(ctx, store.Task{Tenant: captureTenant, ID: job.ID}))
		must(t, s.finalize(ctx, captureTenant, job.ID))
		job, err = s.Job(ctx, tenant, job.ID)
		must(t, err)
		result, err := s.Collection(ctx, tenant, job.CollectionID)
		must(t, err)
		return result
	}
	target := finish(owner, "entry", fixture.target)
	finish(other, "entry", fixture.target)
	fixture.relation, fixture.name = "reposted", "Synthetic old profile"
	actorID := uuid.NewString()
	actor := finish(owner, "collection", actorID)
	fixture.private, fixture.name = true, "Synthetic intermediate profile"
	privateActor := finish(owner, "collection", actorID)
	fixture.private = false
	// A later page need not repeat an older repost edge. Its newer profile data
	// still labels the edge retained in saved history.
	fixture.relation, fixture.name = "", "Synthetic latest profile"
	finish(owner, "collection", actorID)
	authorID := uuid.NewString()
	fixture.name = "Synthetic saved author"
	author := finish(owner, "collection", authorID)
	fixture.author = authorID
	fixture.relation, fixture.name, fixture.private = "quoted", "Synthetic private quote", true
	quote := finish(owner, "entry", uuid.NewString())
	fixture.author = ""
	fixture.relation, fixture.name = "reposted", "Synthetic foreign private profile"
	finish(other, "collection", uuid.NewString())
	fixture.private, fixture.name = false, "Synthetic unsaved public profile"
	finish(other, "collection", uuid.NewString())
	check := func(result domain.Collection) {
		t.Helper()
		if len(result.IncomingRelations) != 2 || len(result.Graph.Relations) != 0 || len(result.Graph.Entities) != 1 {
			t.Fatal("incoming edges missing, duplicated, leaked, or changed stored graph", result.IncomingRelations, result.Graph)
		}
		for _, relation := range result.IncomingRelations {
			var data map[string]string
			must(t, json.Unmarshal(relation.Entity.Data, &data))
			switch relation.Type {
			case "reposted":
				if relation.Author != nil {
					t.Fatal("profile actor acquired an unrelated author", relation)
				}
				if data["name"] != "Synthetic latest profile" || (relation.Entity.SavedCollectionID != actor.ID && relation.Entity.SavedCollectionID != privateActor.ID) {
					t.Fatal("profile data or saved link is stale", relation)
				}
			case "quoted":
				if relation.Author == nil || relation.Author.ExternalID != authorID || relation.Author.SavedCollectionID != author.ID {
					t.Fatal("quote author or saved profile link missing", relation)
				}
				var authorData map[string]string
				must(t, json.Unmarshal(relation.Author.Data, &authorData))
				if authorData["name"] != "Synthetic quote author" {
					t.Fatal("author must come from the source snapshot", authorData)
				}
				if relation.Entity.SavedCollectionID != quote.ID {
					t.Fatal("cross-scope quote not linked", relation)
				}
			default:
				t.Fatal("unexpected relation", relation)
			}
		}
	}
	detail, err := s.SavedCollection(ctx, owner, target.ID)
	must(t, err)
	check(detail.Collection)
	history, err := s.Revision(ctx, owner, target.ID, target.RevisionID)
	must(t, err)
	check(history)
	foreign, err := s.SavedCollection(ctx, other, target.ID)
	must(t, err)
	if len(foreign.IncomingRelations) != 2 {
		t.Fatal("other tenant did not retain its own two sources", foreign.IncomingRelations)
	}
	for _, relation := range foreign.IncomingRelations {
		if relation.Entity.SavedCollectionID == actor.ID || relation.Entity.SavedCollectionID == quote.ID {
			t.Fatal("saved source crossed tenant boundary", relation)
		}
	}
	must(t, s.DeleteCollection(ctx, owner, actor.ID))
	detail, err = s.SavedCollection(ctx, owner, target.ID)
	must(t, err)
	if len(detail.IncomingRelations) != 1 || detail.IncomingRelations[0].Type != "quoted" {
		t.Fatal("unsaved source still contributes an incoming relation", detail.IncomingRelations)
	}
}
