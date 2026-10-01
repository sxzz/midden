package app

import (
	"context"
	"os"
	"slices"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	pb "monitor/api/adapter/v1"
	"monitor/internal/domain"
	"monitor/internal/store"
)

func TestCollectionIdentityHistory(t *testing.T) {
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
	var owner, other string
	must(t, admin.Pool.QueryRow(ctx, `INSERT INTO tenants DEFAULT VALUES RETURNING id`).Scan(&owner))
	must(t, admin.Pool.QueryRow(ctx, `INSERT INTO tenants DEFAULT VALUES RETURNING id`).Scan(&other))
	queue, err := river.NewClient(riverpgxv5.New(db.Pool), &river.Config{})
	must(t, err)
	fake := &fakeAdapter{public: true, text: "public snapshot"}
	s := &Service{DB: db, Queue: queue, Adapter: fake, Config: Defaults(), Blobs: &memoryBlob{m: map[string][]byte{}}}
	capture := func(url string) string {
		job, err := s.Submit(ctx, owner, domain.CaptureInput{URL: url})
		must(t, err)
		must(t, s.capture(ctx, store.Task{Tenant: owner, ID: job.ID}))
		must(t, s.finalize(ctx, owner, job.ID))
		return job.CollectionID
	}
	public := capture("https://x.com/i/status/734510001")
	fake.public = false
	fake.text = "private snapshot"
	// A private observation is a version of the same stored object.
	job, err := s.Submit(ctx, owner, domain.CaptureInput{RefreshID: public})
	must(t, err)
	must(t, s.capture(ctx, store.Task{Tenant: owner, ID: job.ID}))
	must(t, s.finalize(ctx, owner, job.ID))
	if job.CollectionID != public {
		t.Fatal("private observation stored a second copy")
	}
	_, err = admin.Pool.Exec(ctx, `INSERT INTO tenant_collections(tenant_id,collection_id,provider_id,adapter_id) VALUES($1,$2,'fxtwitter','fixture')`, other, public)
	must(t, err)
	page, err := s.Collections(ctx, owner, CollectionFilter{}, "")
	must(t, err)
	if len(page.Items) != 1 || page.Items[0].ID != public || page.Items[0].Text != "private snapshot" {
		t.Fatalf("latest readable version not shown: %+v", page)
	}
	var tag string
	must(t, admin.Pool.QueryRow(ctx, `INSERT INTO tags(tenant_id,name) VALUES($1,'older-source') RETURNING id`, owner).Scan(&tag))
	_, err = admin.Pool.Exec(ctx, `INSERT INTO collection_tags(tenant_id,collection_id,tag_id) VALUES($1,$2,$3)`, owner, public, tag)
	must(t, err)
	tagged, err := s.Collections(ctx, owner, CollectionFilter{Tag: tag}, "")
	must(t, err)
	if len(tagged.Items) != 1 || tagged.Items[0].ID != public {
		t.Fatalf("tag did not match collection: %+v", tagged)
	}
	recent, err := s.Recent(ctx, owner, "")
	must(t, err)
	if len(recent.Items) != 1 || recent.Items[0].ID != public {
		t.Fatalf("recent mismatch: %+v", recent)
	}
	detail, err := s.SavedCollection(ctx, owner, public)
	must(t, err)
	if detail.Text != "private snapshot" || detail.StorageBytes != page.Items[0].StorageBytes {
		t.Fatalf("detail did not resolve latest snapshot: %+v", detail)
	}
	history, err := s.Revisions(ctx, owner, public, "")
	must(t, err)
	if len(history.Items) != 2 {
		t.Fatalf("history missing versions: %+v", history)
	}
	var privateRevision string
	for _, revision := range history.Items {
		old, err := s.Revision(ctx, owner, public, revision.ID)
		must(t, err)
		if old.StorageBytes != detail.StorageBytes {
			t.Fatalf("history storage mismatch")
		}
		if old.Visibility == "private" {
			privateRevision = revision.ID
		}
	}
	// A tenant without access reads only the public version of the same object.
	publicDetail, err := s.SavedCollection(ctx, other, public)
	must(t, err)
	if publicDetail.Text != "public snapshot" || publicDetail.StorageBytes >= detail.StorageBytes {
		t.Fatalf("private snapshot leaked: %+v", publicDetail)
	}
	otherHistory, err := s.Revisions(ctx, other, public, "")
	must(t, err)
	if len(otherHistory.Items) != 1 {
		t.Fatalf("private history leaked: %+v", otherHistory)
	}
	if _, err := s.Revision(ctx, other, public, privateRevision); err == nil {
		t.Fatal("private revision readable without access")
	}
	must(t, db.Tx(ctx, owner, func(tx pgx.Tx) error {
		ids, err := savedIdentityIDs(ctx, tx, public)
		if len(ids) != 1 {
			t.Fatalf("expected one stored copy, got %v", ids)
		}
		return err
	}))
}

func TestRelatedHistoryAndAliases(t *testing.T) {
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
	var owner, other string
	must(t, admin.Pool.QueryRow(ctx, `INSERT INTO tenants DEFAULT VALUES RETURNING id`).Scan(&owner))
	must(t, admin.Pool.QueryRow(ctx, `INSERT INTO tenants DEFAULT VALUES RETURNING id`).Scan(&other))
	queue, err := river.NewClient(riverpgxv5.New(db.Pool), &river.Config{})
	must(t, err)
	fake := &fakeAdapter{public: true, text: "profile page 1", entityTypes: []*pb.EntityType{
		{Name: "x.profile", JsonSchema: []byte(`{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}`)},
		{Name: "x.post", JsonSchema: []byte(`{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}`)},
	}}
	s := &Service{DB: db, Queue: queue, Adapter: fake, Config: Defaults(), Blobs: &memoryBlob{m: map[string][]byte{}}}
	capture := func(input domain.CaptureInput) string {
		job, err := s.Submit(ctx, owner, input)
		must(t, err)
		must(t, s.capture(ctx, store.Task{Tenant: owner, ID: job.ID}))
		must(t, s.finalize(ctx, owner, job.ID))
		return job.CollectionID
	}
	fake.graph = &pb.EntityGraph{Root: "profile", Entities: []*pb.Entity{
		{Key: "profile", Type: "x.profile", DataJson: []byte(`{}`)},
		{Key: "repost", Type: "x.post", ExternalId: "734520002", DataJson: []byte(`{}`), ContextOnly: true},
	}, Relations: []*pb.EntityRelation{{Source: "profile", Target: "repost", Type: "reposted"}}}
	profile := capture(domain.CaptureInput{URL: "https://x.com/i/status/734520001"})
	fake.text = "profile page 2"
	fake.graph = &pb.EntityGraph{Root: "profile", Entities: []*pb.Entity{{Key: "profile", Type: "x.profile", DataJson: []byte(`{}`)}}}
	capture(domain.CaptureInput{RefreshID: profile})
	fake.graph = &pb.EntityGraph{Root: "post", Entities: []*pb.Entity{{Key: "post", Type: "x.post", DataJson: []byte(`{}`)}}}
	repost := capture(domain.CaptureInput{URL: "https://x.com/i/status/734520002"})
	fake.public = false
	fake.graph = &pb.EntityGraph{Root: "post", Entities: []*pb.Entity{
		{Key: "post", Type: "x.post", DataJson: []byte(`{}`)},
		{Key: "mention", Type: "x.profile", ExternalId: "name:fixture_friend", DataJson: []byte(`{"username":"fixture_friend"}`), ContextOnly: true},
	}, Relations: []*pb.EntityRelation{{Source: "post", Target: "mention", Type: "mentions"}}}
	mention := capture(domain.CaptureInput{URL: "https://x.com/i/status/734520003"})
	_, err = admin.Pool.Exec(ctx, `INSERT INTO collection_identity_aliases(platform,kind,object_scope,external_id,collection_id) SELECT platform,kind,object_scope,'name:fixture_friend',id FROM collections WHERE id=$1`, profile)
	must(t, err)
	related, err := s.Collections(ctx, owner, CollectionFilter{RelatedTo: profile, EntityType: "x.post"}, "")
	must(t, err)
	if len(related.Items) != 2 {
		t.Fatalf("historical repost/private mention missing: %+v", related)
	}
	var total int64
	for _, item := range related.Items {
		total += item.StorageBytes
		if item.ID == repost && !slices.Contains(item.RelationTypes, "reposted") {
			t.Fatalf("historical repost label missing: %+v", item.RelationTypes)
		}
		if item.ID != repost && item.ID != mention {
			t.Fatalf("unexpected related collection: %s", item.ID)
		}
	}
	if related.TotalStorageBytes == nil || *related.TotalStorageBytes != total {
		t.Fatalf("related storage mismatch: %+v", related)
	}
	isolated, err := s.Collections(ctx, other, CollectionFilter{RelatedTo: profile, EntityType: "x.post"}, "")
	must(t, err)
	if len(isolated.Items) != 0 || isolated.TotalStorageBytes == nil || *isolated.TotalStorageBytes != 0 {
		t.Fatal("related identities leaked across tenants")
	}
}
