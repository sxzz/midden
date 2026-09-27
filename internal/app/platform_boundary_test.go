package app

import (
	"context"
	"encoding/base64"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"google.golang.org/grpc"

	pb "monitor/api/adapter/v1"
	"monitor/internal/credentials"
	"monitor/internal/domain"
	"monitor/internal/store"
)

// This fixture deliberately uses nonnumeric IDs, an object namespace, and
// provider names unrelated to the bundled adapter.
type notesAdapter struct {
	*fakeAdapter
	last *pb.FetchRequest
}

func (n *notesAdapter) Resolve(_ context.Context, r *pb.ResolveRequest, _ ...grpc.CallOption) (*pb.ResolveResponse, error) {
	u, e := url.Parse(r.Url)
	if e != nil {
		return nil, e
	}
	return &pb.ResolveResponse{Url: r.Url, Platform: u.Hostname(), Kind: "entry", ObjectScope: "notebook", ExternalId: "item-A"}, nil
}

func (n *notesAdapter) Fetch(ctx context.Context, r *pb.FetchRequest, opts ...grpc.CallOption) (*pb.FetchResponse, error) {
	n.last = r
	return n.fakeAdapter.Fetch(ctx, r, opts...)
}

func TestIndependentPlatformCapture(t *testing.T) {
	if os.Getenv("TEST_DATABASE_URL") == "" {
		t.Skip("Docker required")
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
	vault, e := credentials.New(base64.StdEncoding.EncodeToString(make([]byte, 32)))
	must(t, e)
	fake := &notesAdapter{fakeAdapter: &fakeAdapter{public: true, text: "entry"}}
	s := &Service{DB: db, Queue: queue, Vault: vault, AdapterTLS: true, Adapter: fake, Config: Defaults(), Providers: []*pb.Provider{
		{Id: "open-reader", DefaultProvider: true, Authentication: "none", Capabilities: []*pb.Capability{{Name: "capture.fetch", Major: 1}}, Visibilities: []pb.Visibility{pb.Visibility_VISIBILITY_PUBLIC}},
		{Id: "member-reader", DefaultProvider: true, Authentication: "session", Capabilities: []*pb.Capability{{Name: "capture.fetch", Major: 1}, {Name: "connection.check", Major: 1}, {Name: "credential.prepare", Major: 1}}, Visibilities: []pb.Visibility{pb.Visibility_VISIBILITY_PUBLIC, pb.Visibility_VISIBILITY_PRIVATE}},
	}}
	var tenant, other string
	must(t, admin.Pool.QueryRow(ctx, "INSERT INTO tenants DEFAULT VALUES RETURNING id").Scan(&tenant))
	must(t, admin.Pool.QueryRow(ctx, "INSERT INTO tenants DEFAULT VALUES RETURNING id").Scan(&other))
	connection, e := s.ImportConnection(ctx, tenant, "", "Notes", &pb.Credential{Data: []byte("opaque notes session")})
	must(t, e)
	var first string
	for i, host := range []string{"notes.test", "second.test"} {
		j, e := s.Submit(ctx, tenant, domain.CaptureInput{URL: "https://" + host + "/entry/item-A", ConnectionID: connection})
		must(t, e)
		must(t, s.capture(ctx, store.Task{Tenant: tenant, ID: j.ID}))
		must(t, s.finalize(ctx, tenant, j.ID))
		if fake.last.Platform != host || fake.last.Kind != "entry" || fake.last.ObjectScope != "notebook" || fake.last.ExternalId != "item-A" || fake.last.ProviderId != "member-reader" || string(fake.last.Credential.Data) != "opaque notes session" {
			t.Fatal("adapter identity or opaque credentials lost")
		}
		a, e := s.CaptureArchive(ctx, tenant, j.ID)
		must(t, e)
		if i == 0 {
			first = a.ID
		} else if a.ID == first {
			t.Fatal("platform identities collided")
		}
	}
	added, e := s.SavePublicArchive(ctx, other, first)
	must(t, e)
	if !added {
		t.Fatal("shared reference missing")
	}
	j, e := s.Submit(ctx, other, domain.CaptureInput{RefreshID: first})
	must(t, e)
	if j.ProviderID != "open-reader" {
		t.Fatal("wrong anonymous provider", j.ProviderID)
	}
	must(t, s.capture(ctx, store.Task{Tenant: other, ID: j.ID}))
	must(t, s.finalize(ctx, other, j.ID))
	// Session results may become private without changing target normalization.
	fake.public = false
	j, e = s.Submit(ctx, tenant, domain.CaptureInput{URL: "https://private.test/entry/item-A", ConnectionID: connection})
	must(t, e)
	must(t, s.capture(ctx, store.Task{Tenant: tenant, ID: j.ID}))
	must(t, s.finalize(ctx, tenant, j.ID))
	a, e := s.CaptureArchive(ctx, tenant, j.ID)
	must(t, e)
	if _, e = s.Archive(ctx, other, a.ID); e == nil {
		t.Fatal("private archive leaked")
	}
}

// Production core never interprets bundled platform protocols. Channel files
// may provide platform-specific UX; SQL migrations retain deployed history.
func TestCorePlatformBoundary(t *testing.T) {
	files := []string{"service.go", "worker.go", "capture_scope.go", "discovery.go", "connections.go", "account_dialog.go", "account_add.go", "telegram_accounts.go", "commands.go", "download.go", "media_cache.go", "entities.go", "sources.go", "../domain/domain.go", "../credentials/vault.go", "../../api/adapter/v1/adapter.proto"}
	for _, file := range files {
		data, e := os.ReadFile(file)
		must(t, e)
		for _, word := range []string{"fxtwitter", "x-session", "x.com", "twitter.com", "auth_token", "csrf_token", "SessionCredential", `"x"`, `"X"`, "X 帖子", "X 账号"} {
			if strings.Contains(string(data), word) {
				t.Errorf("%s contains platform-specific %s", file, word)
			}
		}
	}
}
