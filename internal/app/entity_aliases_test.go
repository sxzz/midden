package app

import (
	"context"
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

type aliasGraphAdapter struct {
	*collectionAdapter
	alias string
}

func (f *aliasGraphAdapter) Describe(ctx context.Context, r *pb.DescribeRequest, opts ...grpc.CallOption) (*pb.DescribeResponse, error) {
	d, err := f.collectionAdapter.Describe(ctx, r, opts...)
	if err != nil {
		return nil, err
	}
	d.Providers[0].Capabilities = append(d.Providers[0].Capabilities, &pb.Capability{Name: adapter.EntityGraph, Major: 1})
	// Entity types deliberately differ from both the platform and collection kinds.
	for _, name := range []string{"directory.person", "document.entry"} {
		d.EntityTypes = append(d.EntityTypes, &pb.EntityType{Name: name, JsonSchema: []byte(`{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}`)})
		d.Providers[0].EntityTypes = append(d.Providers[0].EntityTypes, name)
	}
	return d, nil
}

func (f *aliasGraphAdapter) Fetch(ctx context.Context, r *pb.FetchRequest, opts ...grpc.CallOption) (*pb.FetchResponse, error) {
	out, err := f.collectionAdapter.Fetch(ctx, r, opts...)
	if err != nil {
		return nil, err
	}
	root := &pb.Entity{Key: "root", Type: "document.entry", ExternalId: r.ExternalId, DataJson: []byte(`{}`)}
	out.Graph = &pb.EntityGraph{Root: "root", Entities: []*pb.Entity{root}}
	if out.CanonicalTarget != nil {
		root.Type, root.ExternalId = "directory.person", out.CanonicalTarget.ExternalId
	} else {
		out.Graph.Entities = append(out.Graph.Entities, &pb.Entity{Key: "mention", Type: "directory.person", ExternalId: f.alias, DataJson: []byte(`{}`), ContextOnly: true})
		out.Graph.Relations = []*pb.EntityRelation{{Source: "root", Target: "mention", Type: "mentions"}}
	}
	return out, nil
}

func TestCanonicalEntityAliasLinks(t *testing.T) {
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
	stable := uuid.NewString()
	alias := "alias-" + stable
	s := &Service{DB: db, Queue: queue, Adapter: &aliasGraphAdapter{&collectionAdapter{&fakeAdapter{}}, alias}, Config: Defaults()}
	s.Config.Rate = 1000
	var a, b string
	must(t, admin.Pool.QueryRow(ctx, `INSERT INTO tenants DEFAULT VALUES RETURNING id`).Scan(&a))
	must(t, admin.Pool.QueryRow(ctx, `INSERT INTO tenants DEFAULT VALUES RETURNING id`).Scan(&b))
	finish := func(tenant, url string) domain.Job {
		t.Helper()
		j, err := s.Submit(ctx, tenant, domain.CaptureInput{URL: url})
		must(t, err)
		must(t, s.capture(ctx, store.Task{Tenant: tenant, ID: j.ID}))
		must(t, s.finalize(ctx, tenant, j.ID))
		j, err = s.Job(ctx, tenant, j.ID)
		must(t, err)
		return j
	}
	post := finish(a, "https://notes.test/entry/"+stable)
	check := func(tenant, want string) {
		t.Helper()
		c, err := s.Collection(ctx, tenant, post.CollectionID)
		must(t, err)
		for _, entity := range c.Graph.Entities {
			if entity.Key == "mention" && entity.SavedCollectionID != want {
				t.Fatalf("alias link = %q, want %q", entity.SavedCollectionID, want)
			}
		}
	}
	check(a, "")
	profile := finish(a, "https://notes.test/collection/"+alias)
	check(a, profile.CollectionID)
	check(b, "")
	// Repeating resolution upserts the same alias, never touching saved snapshots.
	finish(a, "https://notes.test/collection/"+alias)
	check(a, profile.CollectionID)
	finish(b, "https://notes.test/collection/"+stable)
	check(b, profile.CollectionID)
	// Entities are shared by identity and link to the tenant's saved profile.
	// Different platforms and entity kinds remain distinct.
	for _, external := range []string{alias, stable} {
		for _, variant := range []struct{ platform, kind string }{
			{"different", "directory.person"},
			{"notes", "directory.person"},
			{"notes", "directory.other"},
		} {
			var id string
			must(t, db.Tx(ctx, a, func(tx pgx.Tx) error {
				err := tx.QueryRow(ctx, `INSERT INTO entities(platform,kind,external_id) VALUES($1,$2,$3) ON CONFLICT(platform,kind,external_id) DO UPDATE SET observed_at=now() RETURNING id`, variant.platform, variant.kind, external).Scan(&id)
				if err != nil {
					return err
				}
				c := domain.Collection{Graph: &domain.EntityGraph{Entities: []domain.Entity{{ID: id}}}}
				if err = linkSavedEntities(ctx, tx, &c); err != nil {
					return err
				}
				want := ""
				if variant.platform == "notes" && variant.kind == "directory.person" {
					want = profile.CollectionID
				}
				if c.Graph.Entities[0].SavedCollectionID != want {
					t.Fatal("unexpected alias link", variant, c.Graph.Entities[0].SavedCollectionID)
				}
				return nil
			}))
		}
	}

	must(t, db.Tx(ctx, b, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `DELETE FROM tenant_collections WHERE collection_id=$1`, profile.CollectionID)
		return err
	}))
	check(b, "")
}
