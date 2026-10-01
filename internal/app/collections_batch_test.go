package app

import (
	"context"
	"fmt"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	pb "monitor/api/adapter/v1"
	"monitor/internal/domain"
	"monitor/internal/store"
)

type countingCollectionTx struct {
	pgx.Tx
	queries int
}

func (tx *countingCollectionTx) Query(ctx context.Context, query string, args ...any) (pgx.Rows, error) {
	tx.queries++
	return tx.Tx.Query(ctx, query, args...)
}

func TestCollectionsBatch(t *testing.T) {
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
	tenants := make([]string, 2)
	for i := range tenants {
		must(t, admin.Pool.QueryRow(ctx, `INSERT INTO tenants DEFAULT VALUES RETURNING id`).Scan(&tenants[i]))
	}
	queue, err := river.NewClient(riverpgxv5.New(db.Pool), &river.Config{})
	must(t, err)
	fake := &fakeAdapter{public: true, graph: &pb.EntityGraph{Root: "post", Entities: []*pb.Entity{
		{Key: "post", Type: "x.post", DataJson: []byte(`{}`)},
		{Key: "author", Type: "x.profile", ExternalId: "batch-author", DataJson: []byte(`{}`)},
	}}, entityTypes: []*pb.EntityType{
		{Name: "x.post", JsonSchema: []byte(`{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}`)},
		{Name: "x.profile", JsonSchema: []byte(`{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}`)},
	}}
	s := &Service{DB: db, Queue: queue, Adapter: fake, Config: Defaults(), Blobs: &memoryBlob{m: map[string][]byte{}}}
	ids := []string{}
	for i := 0; i < 3; i++ {
		fake.text = fmt.Sprintf("batch text %d", i)
		j, err := s.Submit(ctx, tenants[0], domain.CaptureInput{URL: fmt.Sprintf("https://x.com/a/status/882311%d", i)})
		must(t, err)
		must(t, s.capture(ctx, store.Task{Tenant: tenants[0], ID: j.ID}))
		must(t, s.finalize(ctx, tenants[0], j.ID))
		ids = append(ids, j.CollectionID)
	}
	// Exercise resource grouping and position ordering without external downloads.
	for _, id := range ids[:2] {
		_, err = admin.Pool.Exec(ctx, `INSERT INTO assets(capture_id,position,source_url,purpose,kind,alt_text) SELECT r.capture_id,pos,'https://example.test/image','','image',$1::text FROM revisions r CROSS JOIN unnest(ARRAY[2,0]) pos WHERE r.collection_id=$1::uuid`, id)
		must(t, err)
	}
	for _, tenant := range tenants {
		must(t, db.Tx(ctx, tenant, func(tx pgx.Tx) error {
			counted := &countingCollectionTx{Tx: tx}
			loaded, err := collectionsByID(ctx, counted, []string{ids[2], ids[0], ids[1]})
			if err != nil {
				return err
			}
			if counted.queries != 3 {
				t.Fatalf("batch issued %d queries, want 3", counted.queries)
			}
			for i, id := range ids {
				a := loaded[id]
				if a.Text != fmt.Sprintf("batch text %d", i) {
					t.Fatal("collection payload mixed up")
				}
				if i < 2 {
					if len(a.Assets) != 2 || a.Assets[0].Position != 0 || a.Assets[1].Position != 2 || a.Assets[0].AltText != id || a.Assets[1].AltText != id {
						t.Fatal("media grouping/order lost")
					}
				} else if a.Assets == nil || len(a.Assets) != 0 {
					t.Fatal("empty assets must be an array")
				}
				for _, entity := range a.Graph.Entities {
					want := ""
					if tenant == tenants[0] && entity.Key == a.Graph.Root {
						want = id
					}
					if entity.SavedCollectionID != want {
						t.Fatal("saved link missing or leaked across tenants")
					}
				}
			}
			counted.queries = 0
			empty, err := collectionsByID(ctx, counted, nil)
			if len(empty) != 0 || counted.queries != 0 {
				t.Fatal("empty page queried database")
			}
			return err
		}))
	}
	page, err := s.Collections(ctx, tenants[0], CollectionFilter{EntityType: "x.post", Order: "asc"}, "")
	must(t, err)
	if len(page.Items) != 3 {
		t.Fatal("root filter lost collections")
	}
	for i, item := range page.Items {
		if item.ID != ids[i] {
			t.Fatal("batch changed page ordering")
		}
	}
	foreign, err := s.Collections(ctx, tenants[1], CollectionFilter{EntityType: "x.post"}, "")
	must(t, err)
	if len(foreign.Items) != 0 {
		t.Fatal("unsaved public collections leaked into list")
	}
}
