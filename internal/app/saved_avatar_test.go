package app

import (
	"bytes"
	"context"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"google.golang.org/grpc"

	pb "monitor/api/adapter/v1"
	"monitor/internal/adapter"
	"monitor/internal/domain"
	"monitor/internal/store"
)

// avatarFixture captures a profile with its avatar, and entries whose quoted
// post and author arrive as context without any avatar.
type avatarFixture struct {
	*collectionAdapter
	media, profile, quoted string
}

func (f *avatarFixture) Describe(ctx context.Context, r *pb.DescribeRequest, opts ...grpc.CallOption) (*pb.DescribeResponse, error) {
	out, err := f.collectionAdapter.Describe(ctx, r, opts...)
	if err != nil {
		return nil, err
	}
	out.Providers[0].Capabilities = append(out.Providers[0].Capabilities, &pb.Capability{Name: adapter.EntityGraph, Major: 1})
	for _, name := range []string{"directory.person", "document.entry"} {
		out.EntityTypes = append(out.EntityTypes, &pb.EntityType{Name: name, JsonSchema: []byte(`{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}`)})
		out.Providers[0].EntityTypes = append(out.Providers[0].EntityTypes, name)
	}
	return out, nil
}

func (f *avatarFixture) Fetch(_ context.Context, r *pb.FetchRequest, _ ...grpc.CallOption) (*pb.FetchResponse, error) {
	out := &pb.FetchResponse{ExternalId: r.ExternalId, ProviderId: r.ProviderId, Text: r.ExternalId, Visibility: pb.Visibility_VISIBILITY_PUBLIC}
	author := &pb.Entity{Key: "author", Type: "directory.person", ExternalId: f.profile, DataJson: []byte(`{"name":"Synthetic author","username":"synthetic"}`), ContextOnly: true}
	if r.Kind == "collection" {
		// Another account in the same capture has its own avatar; only the root's may be borrowed.
		out.Resources = []*pb.Resource{{Url: f.media + "/other", Kind: "image", Purpose: "avatar"}, {Url: f.media + "/own", Kind: "image", Purpose: "avatar"}}
		out.Graph = &pb.EntityGraph{Root: "root", Entities: []*pb.Entity{
			{Key: "root", Type: "directory.person", ExternalId: r.ExternalId, DataJson: []byte(`{"name":"Synthetic author"}`), ResourceIndices: []uint32{1}},
			{Key: "other", Type: "directory.person", ExternalId: uuid.NewString(), DataJson: []byte(`{}`), ContextOnly: true, ResourceIndices: []uint32{0}},
		}}
		return out, nil
	}
	out.Graph = &pb.EntityGraph{Root: "root", Entities: []*pb.Entity{{Key: "root", Type: "document.entry", ExternalId: r.ExternalId, DataJson: []byte(`{}`)}, author}, Relations: []*pb.EntityRelation{{Source: "root", Target: "author", Type: "authored_by"}}}
	if r.ExternalId != f.quoted {
		out.Graph.Entities = append(out.Graph.Entities, &pb.Entity{Key: "quote", Type: "document.entry", ExternalId: f.quoted, DataJson: []byte(`{}`), ContextOnly: true})
		out.Graph.Relations = append(out.Graph.Relations, &pb.EntityRelation{Source: "root", Target: "quote", Type: "quoted"}, &pb.EntityRelation{Source: "quote", Target: "author", Type: "authored_by"})
	}
	return out, nil
}

func TestReferencedAuthorsUseSavedAvatar(t *testing.T) {
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
	var data bytes.Buffer
	must(t, png.Encode(&data, image.NewRGBA(image.Rect(0, 0, 3, 3))))
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Distinct bytes per path keep the two avatars apart after deduplication.
		w.Write(append(bytes.Clone(data.Bytes()), r.URL.Path...))
	}))
	defer upstream.Close()
	fixture := &avatarFixture{collectionAdapter: &collectionAdapter{&fakeAdapter{}}, media: upstream.URL, profile: uuid.NewString(), quoted: uuid.NewString()}
	s := &Service{DB: db, Queue: queue, Adapter: fixture, Blobs: &memoryBlob{m: map[string][]byte{}}, HTTP: upstream.Client(), Config: Defaults()}
	s.Config.Rate = 1000
	var tenant string
	must(t, admin.Pool.QueryRow(ctx, `INSERT INTO tenants DEFAULT VALUES RETURNING id`).Scan(&tenant))
	finish := func(kind, external string) domain.Collection {
		t.Helper()
		job, err := s.Submit(ctx, tenant, domain.CaptureInput{URL: "https://notes.test/" + kind + "/" + external})
		must(t, err)
		must(t, s.capture(ctx, store.Task{Tenant: tenant, ID: job.ID}))
		var assets []string
		must(t, db.Tx(ctx, tenant, func(tx pgx.Tx) error {
			rows, err := tx.Query(ctx, `SELECT id FROM assets WHERE capture_id=$1`, job.ID)
			if err != nil {
				return err
			}
			assets, err = pgx.CollectRows(rows, pgx.RowTo[string])
			return err
		}))
		for _, id := range assets {
			must(t, s.download(ctx, store.Task{Tenant: tenant, ID: id, Type: "download"}))
		}
		must(t, s.finalize(ctx, tenant, job.ID))
		job, err = s.Job(ctx, tenant, job.ID)
		must(t, err)
		result, err := s.Collection(ctx, tenant, job.CollectionID)
		must(t, err)
		return result
	}
	profile := finish("collection", fixture.profile)
	var own domain.Asset
	for _, e := range profile.Graph.Entities {
		for _, a := range e.Assets {
			if e.Key == profile.Graph.Root && a.Purpose == "avatar" {
				own = a
			}
		}
	}
	if profile.Graph.Root != "root" || own.ID == "" || own.State != "ready" {
		t.Fatal("profile avatar not saved", profile.Graph.Entities)
	}
	avatarOf := func(e *domain.Entity) string {
		t.Helper()
		if e == nil {
			t.Fatal("author missing")
		}
		for _, a := range e.Assets {
			if a.Purpose == "avatar" {
				return a.ID
			}
		}
		return ""
	}
	quoted := finish("entry", fixture.quoted)
	quoting := finish("entry", uuid.NewString())

	// The quoting entry's own author and its quoted post's author are the saved profile.
	detail, err := s.SavedCollection(ctx, tenant, quoting.ID)
	must(t, err)
	for i := range detail.Graph.Entities {
		e := &detail.Graph.Entities[i]
		if e.Key == "author" && avatarOf(e) != own.ID {
			t.Fatal("referenced author did not get the saved profile's own avatar", e)
		}
		if e.Type == "document.entry" && avatarOf(e) != "" {
			t.Fatal("an entry borrowed an avatar", e)
		}
	}
	// The quoted entry lists its quoting post, whose author shows the same avatar.
	detail, err = s.SavedCollection(ctx, tenant, quoted.ID)
	must(t, err)
	if len(detail.IncomingRelations) != 1 || avatarOf(detail.IncomingRelations[0].Author) != own.ID {
		t.Fatal("incoming quote author has no avatar", detail.IncomingRelations)
	}
	// List rows carry the same avatars.
	page, err := s.Collections(ctx, tenant, CollectionFilter{}, "")
	must(t, err)
	for _, item := range page.Items {
		if item.ID != quoting.ID {
			continue
		}
		for i := range item.Graph.Entities {
			if e := &item.Graph.Entities[i]; e.Key == "author" && avatarOf(e) != own.ID {
				t.Fatal("list row author has no avatar", e)
			}
		}
	}
	// Once the profile is no longer saved, nothing is borrowed from it.
	must(t, s.DeleteCollection(ctx, tenant, profile.ID))
	detail, err = s.SavedCollection(ctx, tenant, quoting.ID)
	must(t, err)
	for i := range detail.Graph.Entities {
		if e := &detail.Graph.Entities[i]; e.Key == "author" && avatarOf(e) != "" {
			t.Fatal("avatar borrowed from an unsaved profile", e)
		}
	}
}
