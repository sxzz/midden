package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	pb "monitor/api/adapter/v1"
	"monitor/internal/channelapi"
	"monitor/internal/credentials"
	"monitor/internal/domain"
	"monitor/internal/store"
)

func TestAccountIsolationAndPublicMerge(t *testing.T) {
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
	tenants := make([]string, 2)
	for i := range tenants {
		must(t, admin.Pool.QueryRow(ctx, `INSERT INTO tenants DEFAULT VALUES RETURNING id`).Scan(&tenants[i]))
	}
	vault, e := credentials.New(base64.StdEncoding.EncodeToString(make([]byte, 32)))
	must(t, e)
	fake := &fakeAdapter{public: true, text: "same content"}
	s := &Service{DB: db, Queue: q, Adapter: fake, Vault: vault, AdapterTLS: true, Config: Defaults(), Providers: []*pb.Provider{{Id: "fxtwitter", Capabilities: []*pb.Capability{{Name: "capture.fetch", Major: 1}}, DefaultProvider: true, Authentication: "none", Visibilities: []pb.Visibility{pb.Visibility_VISIBILITY_PUBLIC}}, {Id: "x-session", Capabilities: []*pb.Capability{{Name: "capture.fetch", Major: 1}, {Name: "connection.check", Major: 1}, {Name: "credential.prepare", Major: 1}}, DefaultProvider: true, Authentication: "session", Visibilities: []pb.Visibility{pb.Visibility_VISIBILITY_PRIVATE, pb.Visibility_VISIBILITY_PUBLIC}}}}
	// A full 200-link message is accepted when the tenant's separate rate quota permits it.
	var batchTenant string
	must(t, admin.Pool.QueryRow(ctx, `INSERT INTO tenants DEFAULT VALUES RETURNING id`).Scan(&batchTenant))
	batchService := *s
	batchService.Config.Rate = 1000
	var batchText strings.Builder
	for i := 0; i < 200; i++ {
		fmt.Fprintf(&batchText, "https://x.com/i/status/%d ", 9900000000000+i)
	}
	batch, _, err := channelTestEvent(t, &batchService, batchTenant, channelapi.Event{Command: "save", URLs: strings.Fields(batchText.String())})
	must(t, err)
	if batch.Count != 200 || len(batch.Errors) > 0 {
		t.Fatal(batch)
	}
	var submitted int
	must(t, admin.Pool.QueryRow(ctx, `SELECT count(*) FROM submissions WHERE tenant_id=$1`, batchTenant).Scan(&submitted))
	if submitted != 200 {
		t.Fatalf("submitted %d links, want 200", submitted)
	}
	var imageData bytes.Buffer
	must(t, png.Encode(&imageData, image.NewRGBA(image.Rect(0, 0, 2, 2))))
	mediaServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write(imageData.Bytes()) }))
	defer mediaServer.Close()
	s.HTTP = mediaServer.Client()
	s.Blobs = &memoryBlob{m: map[string][]byte{}}
	secret := &pb.Credential{Data: []byte("opaque-fixture-credential")}
	ids := make([]string, 2)
	for i := range ids {
		ids[i], e = s.ImportConnection(ctx, tenants[i], "", "fixture", secret)
		must(t, e)
	}
	for i, id := range ids {
		var username string
		must(t, admin.Pool.QueryRow(ctx, `SELECT username FROM connections WHERE id=$1`, id).Scan(&username))
		if username != "fixture" {
			t.Fatalf("API username not saved: %q", username)
		}
		_, e = admin.Pool.Exec(ctx, `UPDATE connections SET username=NULL WHERE id=$1`, id)
		must(t, e)
		must(t, s.CheckConnection(ctx, tenants[i], id))
		must(t, admin.Pool.QueryRow(ctx, `SELECT username FROM connections WHERE id=$1`, id).Scan(&username))
		if username != "fixture" {
			t.Fatal("account check did not refresh handle")
		}
		list, err := s.channelAccounts(ctx, tenants[i])
		must(t, err)
		if len(list.Accounts) != 1 || list.Accounts[0].Username != "fixture" {
			t.Fatal("missing API handle")
		}

	}
	if _, e = s.Submit(ctx, tenants[1], domain.CaptureInput{URL: "https://x.com/a/status/900111", ConnectionID: ids[0]}); !errors.Is(e, ErrConnection) {
		t.Fatalf("cross-tenant connection: %v", e)
	}
	if _, _, e = s.session(ctx, tenants[1], ids[0]); !errors.Is(e, ErrConnection) {
		t.Fatal("foreign credential exposed", e)
	}
	var ciphertext []byte
	must(t, admin.Pool.QueryRow(ctx, `SELECT ciphertext FROM account_credentials WHERE tenant_id=$1`, tenants[0]).Scan(&ciphertext))
	if strings.Contains(string(ciphertext), string(secret.Data)) {
		t.Fatal("plaintext credential stored")
	}
	complete := func(tenant string, in domain.CaptureInput) domain.Job {
		t.Helper()
		j, e := s.Submit(ctx, tenant, in)
		must(t, e)
		if j.State != "complete" && j.State != "partial" {
			must(t, s.capture(ctx, store.Task{Tenant: tenant, ID: j.ID}))
			var media []domain.Asset
			must(t, db.Tx(ctx, tenant, func(tx pgx.Tx) error { var err error; media, err = assets(ctx, tx, j.ID); return err }))
			for _, asset := range media {
				must(t, s.download(ctx, store.Task{Tenant: tenant, ID: asset.ID}))
			}
			must(t, s.finalize(ctx, tenant, j.ID))
		}
		j, e = s.Job(ctx, tenant, j.ID)
		must(t, e)
		return j
	}
	public := complete(tenants[0], domain.CaptureInput{URL: "https://x.com/a/status/900111"})
	// Content another source already stored is shared rather than fetched again.
	personal := complete(tenants[1], domain.CaptureInput{URL: "https://x.com/a/status/900111", ConnectionID: ids[1]})
	if public.CollectionID != personal.CollectionID {
		t.Fatal("public result not merged")
	}
	var count int
	must(t, admin.Pool.QueryRow(ctx, `SELECT count(*) FROM revisions WHERE collection_id=$1`, public.CollectionID).Scan(&count))
	if count != 1 {
		t.Fatal("reused content added a version", count)
	}
	// A stale result fetched with an account starts private until classified.
	s.Config.Rate++ // Allow the additional regression capture in this scenario.
	_, e = admin.Pool.Exec(ctx, `UPDATE collections SET observed_at=now()-interval '1 hour' WHERE id=$1`, personal.CollectionID)
	must(t, e)
	staleCapture, e := s.Submit(ctx, tenants[1], domain.CaptureInput{URL: "https://x.com/a/status/900111", ConnectionID: ids[1], Automatic: true, RefreshAfterSeconds: 60})
	must(t, e)
	var stagingVisibility string
	must(t, admin.Pool.QueryRow(ctx, `SELECT visibility FROM captures WHERE id=$1`, staleCapture.ID).Scan(&stagingVisibility))
	if stagingVisibility != "private" {
		t.Fatal("account capture did not start private")
	}
	must(t, s.capture(ctx, store.Task{Tenant: tenants[1], ID: staleCapture.ID}))
	must(t, s.finalize(ctx, tenants[1], staleCapture.ID))
	must(t, admin.Pool.QueryRow(ctx, `SELECT count(*) FROM revisions WHERE collection_id=$1`, public.CollectionID).Scan(&count))
	if count != 1 {
		t.Fatal("unchanged account result added version", count)
	}
	refresh, e := s.Submit(ctx, tenants[0], domain.CaptureInput{RefreshID: public.CollectionID})
	must(t, e)
	if refresh.ConnectionID != "" || refresh.ProviderID != "fxtwitter" {
		t.Fatal("borrowed another tenant's connection")
	}
	must(t, s.capture(ctx, store.Task{Tenant: tenants[0], ID: refresh.ID}))
	must(t, s.finalize(ctx, tenants[0], refresh.ID))
	refreshed := complete(tenants[1], domain.CaptureInput{RefreshID: personal.CollectionID})
	if refreshed.ConnectionID != ids[1] {
		t.Fatal("refresh lost account selection")
	}
	// A private observation is another version of the same stored object,
	// readable only by tenants that proved access.
	fake.public = false
	fake.text = "private content"
	fake.urls = []string{mediaServer.URL}
	private := complete(tenants[1], domain.CaptureInput{RefreshID: personal.CollectionID})
	if private.CollectionID != public.CollectionID {
		t.Fatal("private observation stored a second copy")
	}
	original, e := s.Collection(ctx, tenants[0], public.CollectionID)
	must(t, e)
	if original.Text != "same content" || original.Visibility != "public" {
		t.Fatal("private version exposed to a tenant without access", original.Text)
	}
	history, e := s.Collection(ctx, tenants[1], private.CollectionID)
	must(t, e)
	if history.Text != "private content" || len(history.Assets) != 1 || history.Visibility != "private" {
		t.Fatal("private version or media missing for the fetching tenant", history)
	}
	// Another account of the same tenant reuses the version it can already read.
	second, e := s.ImportConnection(ctx, tenants[1], "", "second", &pb.Credential{Data: []byte("second-account")})
	must(t, e)
	another := complete(tenants[1], domain.CaptureInput{URL: "https://x.com/a/status/900111", ConnectionID: second})
	if another.CollectionID != private.CollectionID {
		t.Fatal("different connections stored separate copies")
	}
	var blobs int
	must(t, admin.Pool.QueryRow(ctx, `SELECT count(*) FROM blobs b WHERE EXISTS(SELECT FROM assets a JOIN captures c ON c.id=a.capture_id WHERE a.blob_id=b.id AND c.collection_id=$1)`, private.CollectionID).Scan(&blobs))
	if blobs != 1 {
		t.Fatal("media bytes stored more than once", blobs)
	}
	// The same content observed publicly becomes readable by everyone.
	fake.public = true
	restored := complete(tenants[1], domain.CaptureInput{RefreshID: private.CollectionID})
	if restored.CollectionID != public.CollectionID {
		t.Fatal("public refresh changed content identity")
	}
	published, e := s.Collection(ctx, tenants[0], public.CollectionID)
	must(t, e)
	if published.Text != "private content" || published.Visibility != "public" {
		t.Fatal("publicly observed content not shared", published.Text, published.Visibility)
	}
	mergedPage, e := s.Collections(ctx, tenants[1], CollectionFilter{}, "")
	must(t, e)
	if len(mergedPage.Items) != 1 {
		t.Fatal("history appeared as duplicate library entries", len(mergedPage.Items))
	}
	complete(tenants[1], domain.CaptureInput{RefreshID: restored.CollectionID})
	if _, e = s.Collection(ctx, tenants[1], another.CollectionID); e != nil {
		t.Fatal("saved collection lost")
	}
	fake.public = false
	fake.urls = nil
	pending, e := s.Submit(ctx, tenants[1], domain.CaptureInput{URL: "https://x.com/a/status/900112", ConnectionID: second})
	must(t, e)
	must(t, s.capture(ctx, store.Task{Tenant: tenants[1], ID: pending.ID}))
	var deletedCredential string
	must(t, admin.Pool.QueryRow(ctx, `SELECT credential_ref FROM connections WHERE id=$1`, second).Scan(&deletedCredential))
	if _, err := channelTestAction(t, s, tenants[0], "account_delete", "confirm:"+second); err == nil {
		t.Fatal("cross-tenant deletion allowed")
	}
	selectTestAccount(t, s, tenants[1], second)
	confirmation, err := channelTestAction(t, s, tenants[1], "account_delete", second)
	must(t, err)
	if confirmation.Code != "confirm_account_delete" {
		t.Fatal("missing delete confirmation")
	}
	if _, _, err := s.session(ctx, tenants[1], second); err != nil {
		t.Fatal("early revocation", err)
	}
	for range 2 {
		_, err := channelTestAction(t, s, tenants[1], "account_delete", "confirm:"+second)
		must(t, err)
	}
	if selected, err := s.DefaultConnection(ctx, tenants[1]); err != nil || selected != "" {
		t.Fatal("deleted default retained", err)
	}
	if _, _, err := s.session(ctx, tenants[1], second); !errors.Is(err, ErrConnection) {
		t.Fatal("deleted credentials still usable", err)
	}
	must(t, admin.Pool.QueryRow(ctx, `SELECT count(*) FROM account_credentials WHERE id=$1`, deletedCredential).Scan(&count))
	if count != 0 {
		t.Fatal("deleted credential retained")
	}
	menu, err := s.channelAccounts(ctx, tenants[1])
	must(t, err)
	for _, a := range menu.Accounts {
		if a.ID == second {
			t.Fatal("revoked account listed")
		}
	}
	if _, err := s.Collection(ctx, tenants[1], another.CollectionID); err != nil {
		t.Fatal("deleting account removed saved collection", err)
	}
	if e = s.finalize(ctx, tenants[1], pending.ID); !errors.Is(e, ErrConnection) {
		t.Fatal("revoked execution committed", e)
	}
	must(t, s.fail(ctx, store.Task{Tenant: tenants[1], ID: pending.ID, Type: "finalize"}, safeError(ErrConnection)))
	selectTestAccount(t, s, tenants[1], ids[1])
	selected, e := s.DefaultConnection(ctx, tenants[1])
	must(t, e)
	if selected != ids[1] {
		t.Fatal("default not persisted")
	}
	selectTestAccount(t, s, tenants[1], "public")
	selected, e = s.DefaultConnection(ctx, tenants[1])
	must(t, e)
	if selected != "" {
		t.Fatal("public selection still has account")
	}
	must(t, db.Tx(ctx, tenants[0], func(tx pgx.Tx) error {
		var n int
		if e := tx.QueryRow(ctx, `SELECT count(*) FROM account_credentials WHERE tenant_id=$1`, tenants[1]).Scan(&n); e != nil {
			return e
		}
		if n != 0 {
			t.Fatal("credential RLS failed")
		}
		return nil
	}))

	// Rotating credentials while the RPC is running invalidates that result.
	hook := &accountHookAdapter{fakeAdapter: fake}
	s.Adapter = hook
	hook.after = func(ctx context.Context, r *pb.FetchRequest) error {
		if r.Credential == nil || string(r.Credential.Data) != string(secret.Data) {
			t.Fatal("execution credential missing")
		}
		_, err := s.ImportConnection(ctx, tenants[1], ids[1], "rotated", secret)
		return err
	}
	stale, e := s.Submit(ctx, tenants[1], domain.CaptureInput{URL: "https://x.com/a/status/900113", ConnectionID: ids[1]})
	must(t, e)
	if e = s.capture(ctx, store.Task{Tenant: tenants[1], ID: stale.ID}); !errors.Is(e, ErrConnection) {
		t.Fatal("old credential result committed", e)
	}
	must(t, s.fail(ctx, store.Task{Tenant: tenants[1], ID: stale.ID, Type: "capture"}, safeError(ErrConnection)))
	hook.after = func(context.Context, *pb.FetchRequest) error {
		return status.Error(codes.Unauthenticated, "account session expired; authorize again")
	}
	expired, e := s.Submit(ctx, tenants[1], domain.CaptureInput{URL: "https://x.com/a/status/900114", ConnectionID: ids[1]})
	must(t, e)
	if e = s.capture(ctx, store.Task{Tenant: tenants[1], ID: expired.ID}); status.Code(e) != codes.Unauthenticated {
		t.Fatal(e)
	}
	var state string
	must(t, admin.Pool.QueryRow(ctx, `SELECT state FROM connections WHERE id=$1`, ids[1]).Scan(&state))
	if state != "reauth_required" {
		t.Fatal("invalid session not marked")
	}
	must(t, s.fail(ctx, store.Task{Tenant: tenants[1], ID: expired.ID, Type: "capture"}, safeError(ErrConnection)))
	hook.after = nil
	_, e = s.ImportConnection(ctx, tenants[1], ids[1], "renewed", secret)
	must(t, e)
	// A deletion while queued must not be undone by public-scope resolution.
	fake.public = true
	removed, e := s.Submit(ctx, tenants[1], domain.CaptureInput{URL: "https://x.com/a/status/900115", ConnectionID: ids[1]})
	must(t, e)
	_, e = s.DeleteAllCollections(ctx, tenants[1], time.Now().Add(time.Second))
	must(t, e)
	must(t, s.capture(ctx, store.Task{Tenant: tenants[1], ID: removed.ID}))
	must(t, s.finalize(ctx, tenants[1], removed.ID))
	page, e := s.Recent(ctx, tenants[1], "")
	must(t, e)
	if len(page.Items) != 0 {
		t.Fatal("account result resurrected deleted save")
	}
	// Admin CLI must also apply explicit tenant predicates despite its privileged DB role.
	adminService := *s
	adminService.DB = admin
	if e = adminService.RevokeConnection(ctx, tenants[0], ids[1]); !errors.Is(e, domain.ErrNotFound) {
		t.Fatal("admin CLI ignored tenant boundary", e)
	}
}

// Allows credential changes at the exact boundary between remote fetch and commit.
type accountHookAdapter struct {
	*fakeAdapter
	after func(context.Context, *pb.FetchRequest) error
}

func (f *accountHookAdapter) Fetch(ctx context.Context, r *pb.FetchRequest, opts ...grpc.CallOption) (*pb.FetchResponse, error) {
	out, e := f.fakeAdapter.Fetch(ctx, r, opts...)
	if e != nil {
		return nil, e
	}
	if f.after != nil {
		if e = f.after(ctx, r); e != nil {
			return nil, e
		}
	}
	return out, nil
}
