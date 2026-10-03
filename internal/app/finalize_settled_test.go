package app

import (
	"bytes"
	"context"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	pb "monitor/api/adapter/v1"
	"monitor/internal/domain"
	"monitor/internal/store"
)

func TestFinalizeQueuedOnceAndStartsRelated(t *testing.T) {
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
	var imageData bytes.Buffer
	must(t, png.Encode(&imageData, image.NewRGBA(image.Rect(0, 0, 2, 2))))
	media := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write(imageData.Bytes()) }))
	defer media.Close()
	fake := &fakeAdapter{public: true, text: "settled", urls: []string{media.URL + "/a.png", media.URL + "/b.png"}}
	capabilities := []*pb.Capability{{Name: "capture.fetch", Major: 1}, {Name: "capture.related", Major: 1}}
	s := &Service{DB: db, Queue: q, Adapter: fake, HTTP: media.Client(), Blobs: &memoryBlob{m: map[string][]byte{}}, Config: Defaults(), Providers: []*pb.Provider{{Id: "fxtwitter", Capabilities: capabilities, DefaultProvider: true, Authentication: "none", Visibilities: []pb.Visibility{pb.Visibility_VISIBILITY_PUBLIC}}}}
	job, e := s.Submit(ctx, tenant, domain.CaptureInput{URL: "https://x.com/a/status/900661"})
	must(t, e)
	queued := func(id, kind string) (n int) {
		t.Helper()
		must(t, admin.Pool.QueryRow(ctx, `SELECT count(*) FROM river_job WHERE args->>'id'=$1 AND args->>'type'=$2`, id, kind).Scan(&n))
		return n
	}
	must(t, s.capture(ctx, store.Task{Tenant: tenant, ID: job.ID}))
	var pending []domain.Asset
	must(t, db.Tx(ctx, tenant, func(tx pgx.Tx) error { var err error; pending, err = assets(ctx, tx, job.ID); return err }))
	if len(pending) != 2 {
		t.Fatalf("assets: %d", len(pending))
	}
	for i, asset := range pending {
		if n := queued(job.ID, "finalize"); n != 0 {
			t.Fatalf("finalize queued with %d assets pending: %d", len(pending)-i, n)
		}
		must(t, s.download(ctx, store.Task{Tenant: tenant, ID: asset.ID}))
	}
	if n := queued(job.ID, "finalize"); n != 1 {
		t.Fatalf("finalize after the last asset: %d", n)
	}
	var submission string
	must(t, admin.Pool.QueryRow(ctx, `SELECT id FROM submissions WHERE capture_id=$1`, job.ID).Scan(&submission))
	before := queued(submission, "related")
	must(t, s.finalize(ctx, tenant, job.ID))
	if n := queued(submission, "related"); n != before+1 {
		t.Fatalf("related not started by the finished capture: %d, was %d", n, before)
	}
}
