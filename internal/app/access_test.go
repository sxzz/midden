package app

import (
	"context"
	"encoding/base64"
	"os"
	"sync/atomic"
	"testing"

	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "monitor/api/adapter/v1"
	"monitor/internal/credentials"
	"monitor/internal/domain"
	"monitor/internal/store"
)

// accessAdapter answers lightweight access checks and reports embedded
// restricted objects on fetches.
type accessAdapter struct {
	*fakeAdapter
	restricted []*pb.ObjectRef
	fetchErr   error
	check      func(*pb.CheckAccessRequest) (*pb.CheckAccessResponse, error)
	checks     atomic.Int64
}

func (a *accessAdapter) Fetch(ctx context.Context, r *pb.FetchRequest, opts ...grpc.CallOption) (*pb.FetchResponse, error) {
	if a.fetchErr != nil {
		return nil, a.fetchErr
	}
	v, err := a.fakeAdapter.Fetch(ctx, r, opts...)
	if err == nil {
		v.RestrictedTargets = a.restricted
	}
	return v, err
}

func (a *accessAdapter) CheckAccess(_ context.Context, r *pb.CheckAccessRequest, _ ...grpc.CallOption) (*pb.CheckAccessResponse, error) {
	a.checks.Add(1)
	return a.check(r)
}

func TestAccessCheckSharesStoredContent(t *testing.T) {
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
	vault, err := credentials.New(base64.StdEncoding.EncodeToString(make([]byte, 32)))
	must(t, err)
	fake := &accessAdapter{fakeAdapter: &fakeAdapter{text: "protected v1"}}
	fake.check = func(r *pb.CheckAccessRequest) (*pb.CheckAccessResponse, error) {
		return &pb.CheckAccessResponse{Visibility: pb.Visibility_VISIBILITY_PRIVATE, Accessible: append([]*pb.ObjectRef{r.Target}, r.Embedded...)}, nil
	}
	s := &Service{DB: db, Queue: queue, Adapter: fake, Vault: vault, AdapterTLS: true, Config: Defaults(), Blobs: &memoryBlob{m: map[string][]byte{}}, Providers: []*pb.Provider{
		{Id: "fxtwitter", DefaultProvider: true, Authentication: "none", Capabilities: []*pb.Capability{{Name: "capture.fetch", Major: 1}}, Visibilities: []pb.Visibility{pb.Visibility_VISIBILITY_PUBLIC}},
		{Id: "x-session", DefaultProvider: true, Authentication: "session", Capabilities: []*pb.Capability{{Name: "capture.fetch", Major: 1}, {Name: "connection.check", Major: 1}, {Name: "credential.prepare", Major: 1}, {Name: "capture.access", Major: 1}}, Visibilities: []pb.Visibility{pb.Visibility_VISIBILITY_PRIVATE, pb.Visibility_VISIBILITY_PUBLIC}},
	}}
	s.Config.Rate = 100
	tenants := make([]string, 3)
	connections := make([]string, 2)
	for i := range tenants {
		must(t, admin.Pool.QueryRow(ctx, `INSERT INTO tenants DEFAULT VALUES RETURNING id`).Scan(&tenants[i]))
		if i < 2 {
			connections[i], err = s.ImportConnection(ctx, tenants[i], "", "fixture", &pb.Credential{Data: []byte("account")})
			must(t, err)
		}
	}
	a, b, c := tenants[0], tenants[1], tenants[2]
	run := func(tenant string, in domain.CaptureInput) domain.Job {
		t.Helper()
		j, err := s.Submit(ctx, tenant, in)
		must(t, err)
		if j.State == "queued" {
			if err = s.capture(ctx, store.Task{Tenant: tenant, ID: j.ID}); err != nil {
				must(t, s.fail(ctx, store.Task{Tenant: tenant, ID: j.ID, Type: "capture"}, safeError(err)))
			} else if j, err = s.Job(ctx, tenant, j.ID); err == nil && j.State == "downloading" {
				must(t, s.finalize(ctx, tenant, j.ID))
			}
		}
		j, err = s.Job(ctx, tenant, j.ID)
		must(t, err)
		return j
	}
	text := func(tenant, id string) string {
		t.Helper()
		v, err := s.Collection(ctx, tenant, id)
		if err != nil {
			return ""
		}
		return v.Text
	}
	const target = "https://x.com/a/status/99300001"

	first := run(a, domain.CaptureInput{URL: target, ConnectionID: connections[0]})
	if first.State != "complete" || text(a, first.CollectionID) != "protected v1" {
		t.Fatal("account fetch failed", first)
	}
	// Another tenant with an account proves access instead of fetching again.
	fetches := fake.calls.Load()
	shared := run(b, domain.CaptureInput{URL: target, ConnectionID: connections[1]})
	if shared.State != "complete" || shared.CollectionID != first.CollectionID || fake.calls.Load() != fetches || fake.checks.Load() != 1 {
		t.Fatal("access check did not reuse stored content", shared, fake.calls.Load()-fetches, fake.checks.Load())
	}
	if text(b, shared.CollectionID) != "protected v1" {
		t.Fatal("checked tenant cannot read stored content")
	}
	var revisions int
	must(t, admin.Pool.QueryRow(ctx, `SELECT count(*) FROM revisions WHERE collection_id=$1`, first.CollectionID).Scan(&revisions))
	if revisions != 1 {
		t.Fatal("access check stored another copy", revisions)
	}
	// A tenant without proven access reads nothing, even with a forged save.
	_, err = admin.Pool.Exec(ctx, `INSERT INTO tenant_collections(tenant_id,collection_id,provider_id,adapter_id) VALUES($1,$2,'fxtwitter','fixture')`, c, first.CollectionID)
	must(t, err)
	if text(c, first.CollectionID) != "" {
		t.Fatal("private content readable without access")
	}
	usage, err := s.Usage(ctx, b)
	must(t, err)
	if usage.Used == 0 {
		t.Fatal("shared content not charged to the tenant that saved it")
	}

	// Granted access covers versions others observe later.
	fake.text = "protected v2"
	run(a, domain.CaptureInput{RefreshID: first.CollectionID})
	if got := text(b, first.CollectionID); got != "protected v2" {
		t.Fatal("granted tenant missed a newer version", got)
	}
	// Losing access keeps earlier versions but hides newer observations.
	fake.fetchErr = status.Error(codes.PermissionDenied, "no access")
	denied := run(b, domain.CaptureInput{RefreshID: first.CollectionID})
	fake.fetchErr = nil
	if denied.State != "failed" {
		t.Fatal("denied fetch succeeded", denied)
	}
	var revoked bool
	must(t, admin.Pool.QueryRow(ctx, `SELECT revoked_at IS NOT NULL FROM access_grants WHERE tenant_id=$1`, b).Scan(&revoked))
	if !revoked {
		t.Fatal("denied check did not revoke access")
	}
	if got := text(b, first.CollectionID); got != "protected v2" {
		t.Fatal("versions observed before revocation should stay readable", got)
	}
	fake.text = "protected v3"
	run(a, domain.CaptureInput{RefreshID: first.CollectionID})
	if got := text(b, first.CollectionID); got != "protected v2" {
		t.Fatal("version observed after revocation leaked", got)
	}
	if got := text(a, first.CollectionID); got != "protected v3" {
		t.Fatal("fetching tenant lost its own version", got)
	}

	// Embedded restricted objects must be covered by the check as well.
	const quoted = "https://x.com/a/status/99300002"
	fake.text = "quotes a protected post"
	fake.restricted = []*pb.ObjectRef{{Platform: "x", Kind: "post", ExternalId: "99300099"}}
	quote := run(a, domain.CaptureInput{URL: quoted, ConnectionID: connections[0]})
	fake.restricted = nil
	fake.check = func(r *pb.CheckAccessRequest) (*pb.CheckAccessResponse, error) {
		if len(r.Embedded) != 1 || r.Embedded[0].ExternalId != "99300099" {
			t.Fatal("check did not ask about embedded restricted objects", r.Embedded)
		}
		return &pb.CheckAccessResponse{Visibility: pb.Visibility_VISIBILITY_PRIVATE, Accessible: []*pb.ObjectRef{r.Target}}, nil
	}
	partial := run(b, domain.CaptureInput{URL: quoted, ConnectionID: connections[1]})
	if partial.State != "failed" || text(b, quote.CollectionID) != "" {
		t.Fatal("embedded restricted content leaked", partial)
	}
	fake.check = func(r *pb.CheckAccessRequest) (*pb.CheckAccessResponse, error) {
		return &pb.CheckAccessResponse{Visibility: pb.Visibility_VISIBILITY_PRIVATE, Accessible: append([]*pb.ObjectRef{r.Target}, r.Embedded...)}, nil
	}
	full := run(b, domain.CaptureInput{URL: quoted, ConnectionID: connections[1]})
	if full.State != "complete" || text(b, quote.CollectionID) != "quotes a protected post" {
		t.Fatal("full access did not unlock the quoting post", full)
	}

	// Checks reject objects the core never asked about.
	fake.text = "another protected post"
	other := run(a, domain.CaptureInput{URL: "https://x.com/a/status/99300003", ConnectionID: connections[0]})
	fake.check = func(r *pb.CheckAccessRequest) (*pb.CheckAccessResponse, error) {
		return &pb.CheckAccessResponse{Accessible: []*pb.ObjectRef{r.Target, {Platform: "x", Kind: "post", ExternalId: "unrequested"}}}, nil
	}
	if forged := run(b, domain.CaptureInput{URL: "https://x.com/a/status/99300003", ConnectionID: connections[1]}); forged.State != "failed" || text(b, other.CollectionID) != "" {
		t.Fatal("unrequested grant accepted", forged)
	}
}
