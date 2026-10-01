package app

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"google.golang.org/grpc"

	pb "monitor/api/adapter/v1"
	"monitor/internal/adapter"
	"monitor/internal/domain"
	"monitor/internal/store"
)

type collectionAdapter struct{ *fakeAdapter }

func (f *collectionAdapter) Describe(context.Context, *pb.DescribeRequest, ...grpc.CallOption) (*pb.DescribeResponse, error) {
	return &pb.DescribeResponse{ProtocolVersion: "1.0", AdapterId: "collection-fixture", Providers: []*pb.Provider{{Id: "reader", Authentication: "none", DefaultProvider: true, Visibilities: []pb.Visibility{pb.Visibility_VISIBILITY_PUBLIC}, Capabilities: []*pb.Capability{{Name: adapter.CaptureFetch, Major: 1}, {Name: adapter.CaptureRelated, Major: 1}, {Name: adapter.CaptureCanonical, Major: 1}}}}}, nil
}

func (f *collectionAdapter) Resolve(_ context.Context, r *pb.ResolveRequest, _ ...grpc.CallOption) (*pb.ResolveResponse, error) {
	u, e := url.Parse(r.Url)
	if e != nil {
		return nil, e
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(parts) != 2 {
		return nil, fmt.Errorf("bad fixture URL")
	}
	return &pb.ResolveResponse{Url: r.Url, Platform: "notes", Kind: parts[0], ExternalId: parts[1], RefreshOnSubmit: parts[0] == "collection"}, nil
}

func (f *collectionAdapter) Fetch(_ context.Context, r *pb.FetchRequest, _ ...grpc.CallOption) (*pb.FetchResponse, error) {
	f.calls.Add(1)
	out := &pb.FetchResponse{ExternalId: r.ExternalId, ProviderId: r.ProviderId, Visibility: pb.Visibility_VISIBILITY_PUBLIC, Text: r.Kind + ":" + r.ExternalId}
	if r.Kind == "collection" {
		stable := strings.TrimPrefix(r.ExternalId, "alias-")
		out.Text = "collection:" + stable
		out.CanonicalTarget = &pb.ResolveResponse{Url: "https://notes.test/collection/" + stable, Platform: "notes", Kind: "collection", ExternalId: stable}
		if !r.Automatic {
			for i := 0; i < 13; i++ {
				out.RelatedTargets = append(out.RelatedTargets, &pb.RelatedTarget{Url: fmt.Sprintf("https://notes.test/entry/%s-%d", stable, i)})
			}
		}
	} else {
		out.RelatedTargets = []*pb.RelatedTarget{{Url: "https://notes.test/collection/from-entry", RefreshAfterSeconds: 3600}}
	}
	return out, nil
}

func TestRelatedCaptures(t *testing.T) {
	if os.Getenv("TEST_DATABASE_URL") == "" {
		t.Skip("Docker database required")
	}
	ctx := context.Background()
	admin, e := store.Open(ctx, os.Getenv("TEST_ADMIN_DATABASE_URL"))
	must(t, e)
	defer admin.Close()
	db, e := store.Open(ctx, os.Getenv("TEST_DATABASE_URL"))
	must(t, e)
	defer db.Close()
	queue, e := river.NewClient(riverpgxv5.New(db.Pool), &river.Config{})
	must(t, e)
	fake := &collectionAdapter{&fakeAdapter{}}
	cfg := Defaults()
	cfg.Rate = 1000
	s := &Service{DB: db, Queue: queue, Adapter: fake, Config: cfg}
	tenants := []string{"", ""}
	for i := range tenants {
		must(t, admin.Pool.QueryRow(ctx, "INSERT INTO tenants DEFAULT VALUES RETURNING id").Scan(&tenants[i]))
	}
	submit := func(tenant string, in domain.CaptureInput) domain.Job {
		j, e := s.Submit(ctx, tenant, in)
		must(t, e)
		return j
	}
	complete := func(tenant string, j domain.Job) domain.Job {
		must(t, s.capture(ctx, store.Task{Tenant: tenant, ID: j.ID}))
		must(t, s.finalize(ctx, tenant, j.ID))
		j, e := s.Job(ctx, tenant, j.ID)
		must(t, e)
		return j
	}
	related := func(tenant, cid string) {
		var sid string
		must(t, db.Tx(ctx, tenant, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `SELECT id FROM submissions WHERE capture_id=$1 AND related_state='pending' ORDER BY created_at DESC LIMIT 1`, cid).Scan(&sid)
		}))
		must(t, s.related(ctx, store.Task{Tenant: tenant, ID: sid, Type: "related"}))
		must(t, s.related(ctx, store.Task{Tenant: tenant, ID: sid, Type: "related"}))
	}
	a, b := tenants[0], tenants[1]
	// Post-like captures create one related profile-like capture; replay remains idempotent.
	first := complete(a, submit(a, domain.CaptureInput{URL: "https://notes.test/entry/root"}))
	related(a, first.ID)
	var childID string
	must(t, admin.Pool.QueryRow(ctx, `SELECT c.id FROM captures c JOIN collections a ON a.id=c.collection_id WHERE c.tenant_id=$1 AND a.kind='collection'`, a).Scan(&childID))
	child := complete(a, domain.Job{ID: childID})
	var count int
	must(t, admin.Pool.QueryRow(ctx, `SELECT count(*) FROM submissions WHERE capture_id=$1 AND related_state='pending'`, childID).Scan(&count))
	if count != 0 {
		t.Fatal("recursive fanout")
	}
	second := complete(a, submit(a, domain.CaptureInput{URL: "https://notes.test/entry/next"}))
	related(a, second.ID)
	must(t, admin.Pool.QueryRow(ctx, `SELECT count(*) FROM captures WHERE collection_id=$1`, child.CollectionID).Scan(&count))
	if count != 1 {
		t.Fatal("fresh related target fetched again", count)
	}
	_, e = admin.Pool.Exec(ctx, `UPDATE collections SET observed_at=now()-interval '61 minutes' WHERE id=$1`, child.CollectionID)
	must(t, e)
	third := complete(a, submit(a, domain.CaptureInput{URL: "https://notes.test/entry/third"}))
	related(a, third.ID)
	must(t, admin.Pool.QueryRow(ctx, `SELECT count(*) FROM captures WHERE collection_id=$1`, child.CollectionID).Scan(&count))
	if count != 2 {
		t.Fatal("stale related target not refreshed", count)
	}
	// Two tenants share a provisional identity; both acquire the canonical ref and all first-page entries.
	target := "https://notes.test/collection/alias-shared"
	ja := submit(a, domain.CaptureInput{URL: target})
	jb := submit(b, domain.CaptureInput{URL: target})
	if ja.ID != jb.ID {
		t.Fatal("capture did not coalesce")
	}
	ja = complete(a, ja)
	related(a, ja.ID)
	related(b, jb.ID)
	for _, tenant := range tenants {
		must(t, db.Tx(ctx, tenant, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `SELECT count(*) FROM tenant_collections t JOIN collections a ON a.id=t.collection_id WHERE a.kind='entry' AND a.external_id LIKE 'shared-%'`).Scan(&count)
		}))
		if count != 13 {
			t.Fatal("first page lost entries", count)
		}
		must(t, db.Tx(ctx, tenant, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `SELECT count(*) FROM tenant_collections WHERE collection_id=$1`, ja.CollectionID).Scan(&count)
		}))
		if count != 1 {
			t.Fatal("canonical ref not retained")
		}
	}
	// A collected entry hydrates its profile/reference; that second hop must stop.
	var entryCapture, entrySubmission string
	must(t, admin.Pool.QueryRow(ctx, `SELECT c.id,s.id FROM captures c JOIN collections a ON a.id=c.collection_id JOIN submissions s ON s.capture_id=c.id WHERE s.tenant_id=$1 AND a.external_id='shared-0'`, a).Scan(&entryCapture, &entrySubmission))
	complete(a, domain.Job{ID: entryCapture})
	related(a, entryCapture)
	must(t, admin.Pool.QueryRow(ctx, `SELECT count(*) FROM submissions WHERE tenant_id=$1 AND parent_submission=$2 AND related_state='none'`, a, entrySubmission).Scan(&count))
	if count != 1 {
		t.Fatal("collected entry did not hydrate its reference", count)
	}
	// An explicit collection request always refreshes, even inside the freshness window.
	next := submit(a, domain.CaptureInput{URL: "https://notes.test/collection/shared"})
	if next.ID == ja.ID {
		t.Fatal("explicit collection reused old capture")
	}
	next = complete(a, next)
	must(t, admin.Pool.QueryRow(ctx, `SELECT count(*) FROM revisions WHERE collection_id=$1`, next.CollectionID).Scan(&count))
	if count != 1 {
		t.Fatal("unchanged content created another revision", count)
	}
	// An explicit request that joins a running automatic collection still expands the first page.
	implicit := submit(a, domain.CaptureInput{URL: "https://notes.test/collection/joined", Automatic: true})
	explicit := submit(a, domain.CaptureInput{URL: "https://notes.test/collection/joined"})
	if implicit.ID != explicit.ID {
		t.Fatal("inflight collection was not coalesced")
	}
	complete(a, implicit)
	related(a, explicit.ID)
	var expandedID string
	must(t, admin.Pool.QueryRow(ctx, `SELECT c.id FROM captures c JOIN collections a ON a.id=c.collection_id WHERE c.tenant_id=$1 AND a.external_id='joined' AND NOT c.automatic AND c.state='queued'`, a).Scan(&expandedID))
	complete(a, domain.Job{ID: expandedID})
	related(a, expandedID)
	must(t, admin.Pool.QueryRow(ctx, `SELECT count(*) FROM tenant_collections t JOIN collections a ON a.id=t.collection_id WHERE t.tenant_id=$1 AND a.external_id LIKE 'joined-%'`, a).Scan(&count))
	if count != 13 {
		t.Fatal("explicit request lost collection expansion", count)
	}
	// No cross-tenant credentials or callback destinations are attached to implicit children.
	must(t, admin.Pool.QueryRow(ctx, `SELECT count(*) FROM submissions s JOIN captures c ON c.id=s.capture_id WHERE c.automatic AND c.tenant_id IN($1,$2) AND s.chat_id IS NOT NULL`, a, b).Scan(&count))
	if count != 0 {
		t.Fatal("implicit delivery")
	}
}

func TestRelatedCapabilities(t *testing.T) {
	p := &pb.Provider{}
	r := &pb.FetchResponse{RelatedTargets: []*pb.RelatedTarget{{Url: "https://notes.test/entry/1"}}}
	if validateRelatedResult(p, r, "notes", "entry", "") == nil {
		t.Fatal("undeclared expansion accepted")
	}
	p.Capabilities = []*pb.Capability{{Name: adapter.CaptureRelated, Major: 1}, {Name: adapter.CaptureCanonical, Major: 1}}
	must(t, validateRelatedResult(p, r, "notes", "entry", ""))
	r.CanonicalTarget = &pb.ResolveResponse{Url: "https://notes.test/entry/1", Platform: "another", Kind: "entry", ExternalId: "1"}
	if validateRelatedResult(p, r, "notes", "entry", "") == nil {
		t.Fatal("cross-platform identity accepted")
	}
}
