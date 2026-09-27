package app

import (
	"context"
	"encoding/base64"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	pb "monitor/api/adapter/v1"
	"monitor/internal/credentials"
	"monitor/internal/domain"
	"monitor/internal/store"
)

func TestFailedCaptureButtonUsesCurrentAccount(t *testing.T) {
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
	q, err := river.NewClient(riverpgxv5.New(db.Pool), &river.Config{})
	must(t, err)
	vault, err := credentials.New(base64.StdEncoding.EncodeToString(make([]byte, 32)))
	must(t, err)
	s := &Service{DB: db, Queue: q, Vault: vault, AdapterTLS: true, Adapter: &fakeAdapter{public: true, text: "retry"}, Config: Defaults(), Providers: []*pb.Provider{
		{Id: "fxtwitter", Capabilities: []*pb.Capability{{Name: "capture.fetch", Major: 1}}, DefaultProvider: true, Authentication: "none", Visibilities: []pb.Visibility{pb.Visibility_VISIBILITY_PUBLIC}},
		{Id: "x-session", Capabilities: []*pb.Capability{{Name: "capture.fetch", Major: 1}, {Name: "connection.check", Major: 1}, {Name: "credential.prepare", Major: 1}}, DefaultProvider: true, Authentication: "session", Visibilities: []pb.Visibility{pb.Visibility_VISIBILITY_PUBLIC, pb.Visibility_VISIBILITY_PRIVATE}},
	}}
	var tenant, other string
	must(t, admin.Pool.QueryRow(ctx, "INSERT INTO tenants DEFAULT VALUES RETURNING id").Scan(&tenant))
	must(t, admin.Pool.QueryRow(ctx, "INSERT INTO tenants DEFAULT VALUES RETURNING id").Scan(&other))
	cookie := &pb.Credential{Data: []byte("opaque-fixture-credential")}
	old, err := s.ImportConnection(ctx, tenant, "", "old", cookie)
	must(t, err)
	next, err := s.ImportConnection(ctx, tenant, "", "new", &pb.Credential{Data: []byte("new-account")})
	must(t, err)
	for i, selection := range []string{"public", next} {
		job, err := s.Submit(ctx, tenant, domain.CaptureInput{URL: []string{"https://x.com/i/status/99000201", "https://x.com/i/status/99000202"}[i], ConnectionID: old})
		must(t, err)
		must(t, s.fail(ctx, store.Task{Tenant: tenant, ID: job.ID, Type: "capture"}, "account session expired"))
		must(t, s.commandAccount(ctx, &commandRequest{Task: store.Task{Tenant: tenant}, Argument: selection}))
		r := &commandRequest{Task: store.Task{Tenant: tenant, ID: uuid.NewString()}, Argument: job.ArchiveID}
		if i == 0 {
			must(t, s.commandRefresh(ctx, r)) // Existing failure buttons still work.
		} else {
			must(t, s.commandRetry(ctx, r))
		}
		if r.Text != "" {
			t.Fatal(r.Text)
		}
		var got, provider string
		must(t, admin.Pool.QueryRow(ctx, `SELECT coalesce(c.connection_id::text,''),c.provider_id FROM captures c JOIN submissions s ON s.capture_id=c.id WHERE s.tenant_id=$1 AND s.idem_key=$2`, tenant, "retry:"+r.Task.ID).Scan(&got, &provider))
		want := selection
		if selection == "public" {
			want = ""
		}
		if got != want || (want == "" && provider != "fxtwitter") {
			t.Fatal("retry ignored selection", got, provider)
		}
		original, err := s.Job(ctx, tenant, job.ID)
		must(t, err)
		if original.ConnectionID != old {
			t.Fatal("changed original capture connection")
		}
		foreign := &commandRequest{Task: store.Task{Tenant: other, ID: uuid.NewString()}, Argument: job.ArchiveID}
		must(t, s.commandRefresh(ctx, foreign))
		if foreign.Text != "归档不存在或无权限。" {
			t.Fatal("foreign retry permitted")
		}
	}
}
