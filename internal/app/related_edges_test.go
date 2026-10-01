package app

import (
	"context"
	"os"
	"slices"
	"testing"

	"github.com/google/uuid"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"google.golang.org/grpc"

	pb "monitor/api/adapter/v1"
	"monitor/internal/domain"
	"monitor/internal/store"
)

type relatedEdgeFixture struct {
	*incomingFixture
	graph *pb.EntityGraph
}

func (f *relatedEdgeFixture) Fetch(ctx context.Context, request *pb.FetchRequest, options ...grpc.CallOption) (*pb.FetchResponse, error) {
	result, err := f.incomingFixture.Fetch(ctx, request, options...)
	if err == nil && f.graph != nil {
		result.Graph = f.graph
		for _, entity := range result.Graph.Entities {
			if entity.Key == result.Graph.Root {
				entity.ExternalId = request.ExternalId
			}
		}
	}
	return result, err
}

func TestRelatedCollectionsRequireDirectRootEdges(t *testing.T) {
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
	fixture := &relatedEdgeFixture{incomingFixture: &incomingFixture{collectionAdapter: &collectionAdapter{&fakeAdapter{}}, name: "Synthetic fixture"}}
	service := &Service{DB: db, Queue: queue, Adapter: fixture, Config: Defaults()}
	service.Config.Rate = 1000
	capture := func(kind, external string) string {
		t.Helper()
		job, err := service.Submit(ctx, owner, domain.CaptureInput{URL: "https://notes.test/" + kind + "/" + external})
		must(t, err)
		must(t, service.capture(ctx, store.Task{Tenant: owner, ID: job.ID}))
		must(t, service.finalize(ctx, owner, job.ID))
		job, err = service.Job(ctx, owner, job.ID)
		must(t, err)
		return job.CollectionID
	}
	profileExternal := uuid.NewString()
	profile := capture("collection", profileExternal)
	alias := "handle:synthetic_friend_" + uuid.NewString()
	_, err = admin.Pool.Exec(ctx, `INSERT INTO collection_identity_aliases(platform,kind,object_scope,external_id,collection_id) SELECT platform,kind,object_scope,$2,id FROM collections WHERE id=$1`, profile, alias)
	must(t, err)
	entity := func(key, kind, external string) *pb.Entity {
		return &pb.Entity{Key: key, Type: kind, ExternalId: external, DataJson: []byte(`{}`), ContextOnly: key != "root"}
	}
	postGraph := func(target string, relations ...*pb.EntityRelation) *pb.EntityGraph {
		return &pb.EntityGraph{Root: "root", Entities: []*pb.Entity{entity("root", "document.entry", ""), entity("profile", "directory.person", target), entity("author", "directory.person", "synthetic_other_author"), entity("quote", "document.entry", "synthetic_quote")}, Relations: relations}
	}
	edge := func(source, target, kind string) *pb.EntityRelation {
		return &pb.EntityRelation{Source: source, Target: target, Type: kind}
	}
	fixture.private = true
	fixture.graph = postGraph(profileExternal, edge("root", "profile", "authored_by"))
	authored := capture("entry", uuid.NewString())
	fixture.graph = postGraph(alias, edge("root", "profile", "mentions"), edge("author", "profile", "mentions"))
	mentioned := capture("entry", uuid.NewString())
	fixture.graph = postGraph(profileExternal, edge("root", "author", "authored_by"), edge("author", "profile", "mentions"))
	capture("entry", uuid.NewString()) // The author's bio does not relate the post.
	fixture.graph = postGraph(profileExternal, edge("root", "quote", "quoted"), edge("quote", "profile", "authored_by"))
	capture("entry", uuid.NewString()) // A quoted post's author is indirect context.
	fixture.graph = postGraph(profileExternal)
	capture("entry", uuid.NewString()) // Presence in the graph alone proves no edge.
	repostExternal := uuid.NewString()
	fixture.graph = &pb.EntityGraph{Root: "root", Entities: []*pb.Entity{entity("root", "document.entry", "")}}
	repost := capture("entry", repostExternal)
	repostAlias := "entry:synthetic_repost_" + uuid.NewString()
	_, err = admin.Pool.Exec(ctx, `INSERT INTO collection_identity_aliases(platform,kind,object_scope,external_id,collection_id) SELECT platform,kind,object_scope,$2,id FROM collections WHERE id=$1`, repost, repostAlias)
	must(t, err)
	containedExternal := uuid.NewString()
	contained := capture("entry", containedExternal)
	fixture.private = false
	fixture.graph = &pb.EntityGraph{Root: "root", Entities: []*pb.Entity{entity("root", "directory.person", ""), entity("post", "document.entry", repostAlias), entity("member", "document.entry", containedExternal)}, Relations: []*pb.EntityRelation{edge("root", "post", "reposted"), edge("root", "member", "contains")}}
	capture("collection", profileExternal)
	fixture.graph = nil
	fixture.name = "Synthetic later profile page"
	capture("collection", profileExternal)
	result, err := service.Collections(ctx, owner, CollectionFilter{RelatedTo: profile, EntityType: "document.entry"}, "")
	must(t, err)
	want := map[string]string{authored: "authored_by", mentioned: "mentions", repost: "reposted", contained: "contains"}
	if len(result.Items) != len(want) {
		t.Fatalf("indirect context included or direct edges lost: %+v", result.Items)
	}
	var bytes int64
	for _, item := range result.Items {
		kind, ok := want[item.ID]
		if !ok || !slices.Equal(item.RelationTypes, []string{kind}) {
			t.Fatalf("wrong relation semantics: %+v", item)
		}
		bytes += item.StorageBytes
	}
	if result.TotalStorageBytes == nil || *result.TotalStorageBytes != bytes {
		t.Fatal("storage includes indirect context", result.TotalStorageBytes, bytes)
	}
	isolated, err := service.Collections(ctx, other, CollectionFilter{RelatedTo: profile, EntityType: "document.entry"}, "")
	must(t, err)
	if len(isolated.Items) != 0 || isolated.TotalStorageBytes == nil || *isolated.TotalStorageBytes != 0 {
		t.Fatal("related edges leaked tenant data", isolated)
	}
}
