package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	pb "monitor/api/adapter/v1"
	"monitor/internal/adapter"
	"monitor/internal/adapter/adaptertest"
	"monitor/internal/channelapi"
	"monitor/internal/credentials"
	"monitor/internal/domain"
	"monitor/internal/store"
)

func TestInstagramTypeScriptLifecycleAndTelegramSelection(t *testing.T) {
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
	var pixels bytes.Buffer
	must(t, png.Encode(&pixels, image.NewRGBA(image.Rect(0, 0, 5, 7))))
	var downloads atomic.Int64
	media := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { downloads.Add(1); w.Write(pixels.Bytes()) }))
	defer media.Close()
	textFile := filepath.Join(t.TempDir(), "caption.txt")
	must(t, os.WriteFile(textFile, []byte("initial caption"), 0o600))
	addresses, ca := adaptertest.Start(t, "", media.URL, "FIXTURE_REVISION_FILE="+textFile)
	var endpoints []AdapterEndpoint
	for _, address := range addresses {
		conn, err := adapter.Dial(address, "fixture", ca)
		must(t, err)
		defer conn.Close()
		endpoints = append(endpoints, AdapterEndpoint{Client: pb.NewAdapterClient(conn), TLS: true})
	}
	registry := NewAdapterRegistry(endpoints)
	must(t, registry.Refresh(ctx))
	if len(registry.snapshot()) != 2 {
		t.Fatal("bundled adapters were not discovered")
	}
	vault, e := credentials.New(base64.StdEncoding.EncodeToString(make([]byte, 32)))
	must(t, e)
	s := &Service{DB: db, Queue: queue, Vault: vault, Registry: registry, Config: Defaults(), HTTP: media.Client(), Blobs: &memoryBlob{m: map[string][]byte{}}}
	s.Config.Rate = 1000
	var tenant string
	must(t, admin.Pool.QueryRow(ctx, "INSERT INTO tenants DEFAULT VALUES RETURNING id").Scan(&tenant))
	if _, e = s.Submit(ctx, tenant, domain.CaptureInput{URL: "https://instagram.com/p/C/"}); !errors.Is(e, ErrAccountRequired) {
		t.Fatal("Instagram accepted anonymous submission", e)
	}
	noAccount, _, e := channelTestEvent(t, s, tenant, channelapi.Event{Command: "save", URLs: []string{"https://x.com/i/web/status/99001230", "https://instagram.com/p/C/"}})
	must(t, e)
	if noAccount.Count != 1 || len(noAccount.Errors) != 1 || noAccount.Errors[0] != safeError(ErrAccountRequired) {
		t.Fatal("mixed links did not keep X and explain Instagram credentials", noAccount)
	}
	ig, e := s.forAdapter("instagram")
	must(t, e)
	igAccount, e := ig.ImportConnection(ctx, tenant, "", "Instagram", &pb.Credential{Data: []byte(base64.StdEncoding.EncodeToString([]byte("sessionid=fixture-session")))})
	must(t, e)
	accounts, e := s.Accounts(ctx, tenant)
	must(t, e)
	for _, p := range accounts.Platforms {
		if p.ID == "instagram" && p.Public {
			t.Fatal("Instagram exposed a public source")
		}
	}
	finish := func(input domain.CaptureInput) domain.Job {
		t.Helper()
		job, err := s.Submit(ctx, tenant, input)
		must(t, err)
		must(t, s.capture(ctx, store.Task{Tenant: tenant, ID: job.ID}))
		var pending []domain.Asset
		must(t, db.Tx(ctx, tenant, func(tx pgx.Tx) error { var err error; pending, err = assets(ctx, tx, job.ID); return err }))
		for _, asset := range pending {
			must(t, s.download(ctx, store.Task{Tenant: tenant, ID: asset.ID}))
		}
		must(t, s.finalize(ctx, tenant, job.ID))
		job, err = s.Job(ctx, tenant, job.ID)
		must(t, err)
		return job
	}
	first := finish(domain.CaptureInput{URL: "https://www.instagram.com/reel/C/?igsh=fixture", ConnectionID: igAccount})
	duplicate, e := s.Submit(ctx, tenant, domain.CaptureInput{URL: "https://instagram.com/tv/C/", ConnectionID: igAccount})
	must(t, e)
	if duplicate.CollectionID != first.CollectionID {
		t.Fatal("post variants were not deduplicated")
	}
	must(t, os.WriteFile(textFile, []byte("updated caption"), 0o600))
	refreshed := finish(domain.CaptureInput{RefreshID: first.CollectionID})
	if refreshed.CollectionID != first.CollectionID {
		t.Fatal("refresh lost identity")
	}
	revisions, e := s.Revisions(ctx, tenant, first.CollectionID, "")
	must(t, e)
	if len(revisions.Items) != 2 {
		t.Fatal("Instagram history missing", revisions)
	}
	if downloads.Load() != 1 {
		t.Fatal("immutable media was downloaded again", downloads.Load())
	}
	x, e := s.forAdapter("x")
	must(t, e)
	// Fixed account verification keeps this test independent of any real session.
	x.Adapter = &fakeAdapter{}
	xAccount, e := x.ImportConnection(ctx, tenant, "", "X", &pb.Credential{Data: []byte(`{"authToken":"fixture","csrfToken":"fixture"}`)})
	must(t, e)
	result, work, e := channelTestEvent(t, s, tenant, channelapi.Event{Command: "save", URLs: []string{"https://x.com/i/web/status/99001234", "https://instagram.com/p/D/", "https://instagram.com/reel/D/"}})
	must(t, e)
	if result.Count != 2 || len(result.Errors) > 0 {
		t.Fatal("Telegram mixed-platform submission or dedup failed", result)
	}
	rows, e := admin.Pool.Query(ctx, `SELECT c.adapter_id,c.connection_id::text FROM captures c JOIN submissions s ON s.capture_id=c.id WHERE s.idem_key LIKE $1 ORDER BY c.adapter_id`, work.ID+":%")
	must(t, e)
	defer rows.Close()
	choices := map[string]string{}
	for rows.Next() {
		var platform, account string
		must(t, rows.Scan(&platform, &account))
		choices[platform] = account
	}
	must(t, rows.Err())
	if choices["x"] != xAccount || choices["instagram"] != igAccount {
		t.Fatal("Telegram selected the wrong platform account", choices)
	}
	var used int64
	usage, e := s.Usage(ctx, tenant)
	must(t, e)
	used = usage.Used
	if used == 0 {
		t.Fatal("Instagram bytes were not charged")
	}
	_, e = admin.Pool.Exec(ctx, "UPDATE tenants SET quota_bytes=$2 WHERE id=$1", tenant, used)
	must(t, e)
	if _, e = s.Submit(ctx, tenant, domain.CaptureInput{URL: "https://instagram.com/p/E/", ConnectionID: igAccount}); e == nil {
		t.Fatal("Instagram exceeded quota")
	}
}
