package app

import (
	"bytes"
	"context"
	"image"
	"image/jpeg"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	"monitor/internal/domain"
	"monitor/internal/store"
)

func TestRenderThumbnail(t *testing.T) {
	encoder := thumbnailEncoder()
	if encoder == "" {
		t.Skip("ffmpeg required")
	}
	dir := t.TempDir()
	for _, tc := range []struct {
		name                        string
		width, height, wantW, wantH int
	}{
		{"wide", 2000, 1000, 800, 400},
		{"tall", 500, 1500, 400, 1200},
		{"extreme", 400, 6000, 80, 1200},
		// Never enlarged.
		{"small", 300, 200, 300, 200},
	} {
		source := filepath.Join(dir, tc.name+".png")
		f, err := os.Create(source)
		must(t, err)
		must(t, png.Encode(f, image.NewRGBA(image.Rect(0, 0, tc.width, tc.height))))
		must(t, f.Close())
		out := filepath.Join(dir, tc.name+".out")
		mime, err := renderThumbnail(context.Background(), encoder, source, out)
		must(t, err)
		// Decoding WebP needs a library the module does not carry; JPEG output
		// checks the geometry, which both encoders share.
		if mime == "image/jpeg" {
			raw, err := os.Open(out)
			must(t, err)
			cfg, err := jpeg.DecodeConfig(raw)
			raw.Close()
			must(t, err)
			if cfg.Width != tc.wantW || cfg.Height != tc.wantH {
				t.Fatal(tc.name, cfg.Width, cfg.Height)
			}
		}
	}
	if _, err := renderThumbnail(context.Background(), encoder, filepath.Join(dir, "missing"), filepath.Join(dir, "none")); err == nil {
		t.Fatal("rendered a missing file")
	}
}

func TestThumbnailsAreDerivedPerBlobAndCollectedWithIt(t *testing.T) {
	if os.Getenv("TEST_DATABASE_URL") == "" {
		t.Skip("Docker database required")
	}
	if thumbnailEncoder() == "" {
		t.Skip("ffmpeg required")
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
	var data bytes.Buffer
	must(t, png.Encode(&data, image.NewRGBA(image.Rect(0, 0, 900, 700))))
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/broken" {
			w.Write(append([]byte("\x89PNG\r\n\x1a\n"), "not an image"...))
			return
		}
		w.Write(data.Bytes())
	}))
	defer upstream.Close()
	fake := &fakeAdapter{public: true, text: "thumbnail", urls: []string{upstream.URL + "/ok", upstream.URL + "/broken"}}
	mem := &memoryBlob{m: map[string][]byte{}}
	s := &Service{DB: db, Queue: queue, Adapter: fake, Blobs: mem, HTTP: upstream.Client(), Config: Defaults()}
	var tenant string
	must(t, admin.Pool.QueryRow(ctx, `INSERT INTO tenants DEFAULT VALUES RETURNING id`).Scan(&tenant))
	job, err := s.Submit(ctx, tenant, domain.CaptureInput{URL: "https://x.com/i/status/9900777"})
	must(t, err)
	must(t, s.capture(ctx, store.Task{Tenant: tenant, ID: job.ID}))
	type media struct{ asset, blob string }
	var items []media
	must(t, db.Tx(ctx, tenant, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT id FROM assets WHERE capture_id=$1 ORDER BY position`, job.ID)
		if err != nil {
			return err
		}
		ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
		for _, id := range ids {
			items = append(items, media{asset: id})
		}
		return err
	}))
	for i := range items {
		must(t, s.download(ctx, store.Task{Tenant: tenant, ID: items[i].asset, Type: "download"}))
		must(t, db.Tx(ctx, tenant, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `SELECT blob_id FROM assets WHERE id=$1`, items[i].asset).Scan(&items[i].blob)
		}))
	}
	must(t, s.finalize(ctx, tenant, job.ID))
	// Each ready asset queued a thumbnail for its blob.
	var queued int
	must(t, admin.Pool.QueryRow(ctx, `SELECT count(*) FROM river_job WHERE args->>'type'='thumbnail' AND args->>'id'=ANY($1)`, []string{items[0].blob, items[1].blob}).Scan(&queued))
	if queued != 2 {
		t.Fatal("thumbnail tasks queued", queued)
	}
	before := mem.puts.Load()
	usage, err := s.Usage(ctx, tenant)
	must(t, err)
	usedBefore := usage.Used
	for _, m := range items {
		must(t, s.thumbnail(ctx, store.Task{Tenant: tenant, ID: m.blob, Type: "thumbnail"}))
		// A duplicate task finds the work done.
		must(t, s.thumbnail(ctx, store.Task{Tenant: tenant, ID: m.blob, Type: "thumbnail"}))
	}
	if mem.puts.Load() != before+1 {
		t.Fatal("thumbnail uploads", mem.puts.Load()-before)
	}
	job, err = s.Job(ctx, tenant, job.ID)
	must(t, err)
	saved, err := s.Collection(ctx, tenant, job.CollectionID)
	must(t, err)
	if len(saved.Assets) != 2 || !saved.Assets[0].Thumbnail || saved.Assets[1].Thumbnail {
		t.Fatal("thumbnail flags", saved.Assets)
	}
	thumb, err := s.Thumbnail(ctx, tenant, items[0].asset)
	must(t, err)
	original, err := s.Asset(ctx, tenant, items[0].asset)
	must(t, err)
	if thumb.Key == original.Key || thumb.Size <= 0 || int64(len(mem.m[thumb.Key])) != thumb.Size || (thumb.MIME != "image/webp" && thumb.MIME != "image/jpeg") {
		t.Fatal("thumbnail object", thumb)
	}
	// An unrenderable file is given up on, not retried, and has no thumbnail.
	if _, err = s.Thumbnail(ctx, tenant, items[1].asset); err == nil {
		t.Fatal("broken image has a thumbnail")
	}
	var state string
	must(t, db.Tx(ctx, tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT state FROM blob_thumbnails WHERE blob_id=$1`, items[1].blob).Scan(&state)
	}))
	if state != "failed" {
		t.Fatal(state)
	}
	// Thumbnails are derived data: usage counts the originals only.
	usage, err = s.Usage(ctx, tenant)
	must(t, err)
	if usage.Used != usedBefore {
		t.Fatal("thumbnails changed usage", usedBefore, usage.Used)
	}
	// When the blob goes, its thumbnail's object is left to object GC.
	if _, err = admin.Pool.Exec(ctx, `DELETE FROM blob_thumbnails WHERE blob_id=$1`, items[0].blob); err != nil {
		t.Fatal(err)
	}
	must(t, admin.Pool.QueryRow(ctx, `SELECT state FROM objects WHERE object_key=$1`, thumb.Key).Scan(&state))
	if state != "garbage" {
		t.Fatal("thumbnail object not collected", state)
	}
	// Maintenance queues blobs that have none yet.
	must(t, s.backfillThumbnails(ctx))
	must(t, admin.Pool.QueryRow(ctx, `SELECT count(*) FROM river_job WHERE args->>'type'='thumbnail' AND args->>'id'=$1`, items[0].blob).Scan(&queued))
	if queued < 1 {
		t.Fatal("backfill did not queue the blob")
	}
}
