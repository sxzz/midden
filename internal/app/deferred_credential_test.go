package app

import (
	"context"
	"encoding/base64"
	"errors"
	"os"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	pb "monitor/api/adapter/v1"
	"monitor/internal/credentials"
	"monitor/internal/domain"
	"monitor/internal/store"
)

type deferringAdapter struct {
	*fakeAdapter
	needAccount bool
	withAccount []bool
}

func (f *deferringAdapter) Fetch(ctx context.Context, r *pb.FetchRequest, opts ...grpc.CallOption) (*pb.FetchResponse, error) {
	f.withAccount = append(f.withAccount, r.Credential != nil)
	if r.Credential == nil && (!r.CredentialDeferred || f.needAccount) {
		for _, opt := range opts {
			if trailer, ok := opt.(grpc.TrailerCallOption); ok {
				*trailer.TrailerAddr = metadata.Pairs("credential-required", "1")
			}
		}
		return nil, status.Error(codes.FailedPrecondition, "account required")
	}
	return f.fakeAdapter.Fetch(ctx, r, opts...)
}

func TestCaptureTakesAccountTurnOnlyWhenAdapterNeedsIt(t *testing.T) {
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
	q, e := river.NewClient(riverpgxv5.New(db.Pool), &river.Config{})
	must(t, e)
	var tenant string
	must(t, admin.Pool.QueryRow(ctx, `INSERT INTO tenants DEFAULT VALUES RETURNING id`).Scan(&tenant))
	vault, e := credentials.New(base64.StdEncoding.EncodeToString(make([]byte, 32)))
	must(t, e)
	fake := &deferringAdapter{fakeAdapter: &fakeAdapter{public: true, text: "deferred"}}
	session := []*pb.Capability{{Name: "capture.fetch", Major: 1}, {Name: "connection.check", Major: 1}, {Name: "credential.prepare", Major: 1}, {Name: "credential.deferred", Major: 1}}
	s := &Service{DB: db, Queue: q, Adapter: fake, Vault: vault, AdapterTLS: true, Config: Defaults(), Providers: []*pb.Provider{{Id: "x-session", Capabilities: session, DefaultProvider: true, Authentication: "session", Visibilities: []pb.Visibility{pb.Visibility_VISIBILITY_PRIVATE, pb.Visibility_VISIBILITY_PUBLIC}}}}
	connection, e := s.ImportConnection(ctx, tenant, "", "fixture", &pb.Credential{Data: []byte("opaque-fixture-credential")})
	must(t, e)

	// Another capture holds the account for the whole test.
	busy, e := s.connectionTurn(ctx, connection)
	must(t, e)
	wait := connectionWait
	connectionWait = 50 * time.Millisecond
	defer func() { connectionWait = wait }()

	job, e := s.Submit(ctx, tenant, domain.CaptureInput{URL: "https://x.com/a/status/900551", ConnectionID: connection})
	must(t, e)
	must(t, s.capture(ctx, store.Task{Tenant: tenant, ID: job.ID}))
	if len(fake.withAccount) != 1 || fake.withAccount[0] {
		t.Fatalf("fetch that needs no account: %v", fake.withAccount)
	}

	fake.needAccount, fake.withAccount = true, nil
	job, e = s.Submit(ctx, tenant, domain.CaptureInput{URL: "https://x.com/a/status/900552", ConnectionID: connection})
	must(t, e)
	var snooze *river.JobSnoozeError
	if e = s.capture(ctx, store.Task{Tenant: tenant, ID: job.ID}); !errors.As(e, &snooze) {
		t.Fatalf("capture ran beside the account's other capture: %v", e)
	}
	busy()
	must(t, s.capture(ctx, store.Task{Tenant: tenant, ID: job.ID}))
	if len(fake.withAccount) != 3 || fake.withAccount[0] || fake.withAccount[1] || !fake.withAccount[2] {
		t.Fatalf("fetch that needs the account: %v", fake.withAccount)
	}
}
