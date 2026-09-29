package app

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	"monitor/internal/domain"
	"monitor/internal/store"
)

func TestImageUploadDedupAndImmutableCache(t *testing.T) {
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
	var data bytes.Buffer
	must(t, png.Encode(&data, image.NewRGBA(image.Rect(0, 0, 23, 17))))
	var downloads atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { downloads.Add(1); w.Write(data.Bytes()) }))
	defer upstream.Close()
	fake := &fakeAdapter{public: true, text: "dedup", urls: []string{upstream.URL}}
	mem := &memoryBlob{m: map[string][]byte{}}
	s := &Service{DB: db, Queue: q, Adapter: fake, Blobs: mem, HTTP: upstream.Client(), Config: Defaults()}
	tenants := make([]string, 2)
	jobs := make([]domain.Job, 2)
	ids := make([]string, 2)
	for i := range tenants {
		must(t, admin.Pool.QueryRow(ctx, "INSERT INTO tenants DEFAULT VALUES RETURNING id").Scan(&tenants[i]))
		jobs[i], e = s.Submit(ctx, tenants[i], domain.CaptureInput{URL: fmt.Sprintf("https://x.com/i/status/990009%d", i)})
		must(t, e)
		must(t, s.capture(ctx, store.Task{Tenant: tenants[i], ID: jobs[i].ID}))
		must(t, db.Tx(ctx, tenants[i], func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, "SELECT id FROM assets WHERE capture_id=$1", jobs[i].ID).Scan(&ids[i])
		}))
	}
	var wg sync.WaitGroup
	for i := range tenants {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if err := s.download(ctx, store.Task{Tenant: tenants[i], ID: ids[i]}); err != nil {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	if t.Failed() {
		t.FailNow()
	}
	if mem.puts.Load() != 1 || downloads.Load() != 2 {
		t.Fatal("concurrent duplicate upload", mem.puts.Load(), downloads.Load())
	}
	for i := range tenants {
		must(t, s.finalize(ctx, tenants[i], jobs[i].ID))
	}
	fake.cacheKey = "x:avatar:synthetic-image-url"
	refresh := func() {
		job, err := s.Submit(ctx, tenants[0], domain.CaptureInput{RefreshID: jobs[0].CollectionID})
		must(t, err)
		must(t, s.capture(ctx, store.Task{Tenant: tenants[0], ID: job.ID}))
		var id string
		must(t, db.Tx(ctx, tenants[0], func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, "SELECT id FROM assets WHERE capture_id=$1", job.ID).Scan(&id)
		}))
		must(t, s.download(ctx, store.Task{Tenant: tenants[0], ID: id}))
		must(t, s.finalize(ctx, tenants[0], job.ID))
	}
	refresh() // Establish immutable key using existing hash: download, no upload.
	refresh() // Same key: neither download nor upload.
	if downloads.Load() != 3 || mem.puts.Load() != 1 {
		t.Fatal("image cache missed", downloads.Load(), mem.puts.Load())
	}
	fake.cacheKey = "x:avatar:new-image-url"
	refresh()
	if downloads.Load() != 4 || mem.puts.Load() != 1 {
		t.Fatal("new URL not fetched or duplicate uploaded")
	}
}
