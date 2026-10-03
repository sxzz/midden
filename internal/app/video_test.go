package app

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	"monitor/internal/domain"
	"monitor/internal/store"
)

func TestVideoCache(t *testing.T) {
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
	video := make([]byte, 128)
	binary.BigEndian.PutUint32(video, 24)
	copy(video[4:], "ftypisom")
	copy(video[16:], "isomiso4")
	var downloads atomic.Int32
	h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { downloads.Add(1); w.Write(video) }))
	defer h.Close()
	f := &fakeAdapter{public: true, mediaKind: "video", cacheKey: "media-id:1080p", altText: "a video description", urls: []string{h.URL}}
	mem := &memoryBlob{m: map[string][]byte{}}
	s := &Service{DB: db, Queue: q, Adapter: f, Config: Defaults(), HTTP: h.Client(), Blobs: mem}
	newTenant := func() string {
		var id string
		must(t, admin.Pool.QueryRow(ctx, `INSERT INTO tenants DEFAULT VALUES RETURNING id`).Scan(&id))
		return id
	}
	a, b := newTenant(), newTenant()
	complete := func(tenant string, post int, refresh string) domain.Collection {
		j, e := s.Submit(ctx, tenant, domain.CaptureInput{URL: fmt.Sprintf("https://x.com/a/status/%d", post), RefreshID: refresh})
		must(t, e)
		must(t, s.capture(ctx, store.Task{Tenant: tenant, ID: j.ID}))
		var aa []domain.Asset
		must(t, db.Tx(ctx, tenant, func(tx pgx.Tx) error { var e error; aa, e = assets(ctx, tx, j.ID); return e }))
		if len(aa) != 1 {
			t.Fatal(aa)
		}
		must(t, s.download(ctx, store.Task{Tenant: tenant, ID: aa[0].ID}))
		must(t, s.finalize(ctx, tenant, j.ID))
		ar, e := s.Collection(ctx, tenant, j.CollectionID)
		must(t, e)
		if len(ar.Assets) != 1 || ar.Assets[0].MIME != "video/mp4" || ar.Assets[0].Size != int64(len(video)) {
			t.Fatal(ar)
		}
		r, e := mem.Get(ctx, ar.Assets[0].Key)
		must(t, e)
		stored, e := io.ReadAll(r)
		r.Close()
		must(t, e)
		if !bytes.Equal(stored, video) {
			t.Fatal("changed video bytes")
		}
		return ar
	}
	first := complete(a, 980001, "")
	refreshed := complete(a, 980001, first.ID)
	if first.RevisionID != refreshed.RevisionID {
		t.Fatal("unchanged media created revision")
	}
	shared := complete(b, 980002, "")
	if shared.Assets[0].AltText != "a video description" {
		t.Fatal("description missing")
	}
	if downloads.Load() != 1 || shared.Assets[0].Key != first.Assets[0].Key {
		t.Fatal("cache missed", downloads.Load())
	}
	for _, tenant := range []string{a, b} {
		must(t, db.Tx(ctx, tenant, func(tx pgx.Tx) error {
			var used, reserved int64
			e := tx.QueryRow(ctx, `SELECT tenant_usage(),reserved_bytes FROM tenants WHERE id=$1`, tenant).Scan(&used, &reserved)
			if used < 128 || reserved != 0 {
				t.Error("incorrect quota", used, reserved)
			}
			return e
		}))
	}
	f.altText = "updated description"
	changed := complete(a, 980001, first.ID)
	if changed.RevisionID == first.RevisionID || downloads.Load() != 1 {
		t.Fatal("description revision or cache incorrect")
	}
	f.sensitive = true
	sensitive := complete(a, 980001, first.ID)
	if !sensitive.Assets[0].Sensitive || sensitive.RevisionID == changed.RevisionID || downloads.Load() != 1 {
		t.Fatal("sensitive flag not versioned or bypassed cache")
	}
	// A different rendition must not hit the old ID cache.
	f.cacheKey = "media-id:2160p"
	complete(b, 980003, "")
	if downloads.Load() != 2 {
		t.Fatal("quality cache collision")
	}
	// Media an account fetch lists is reusable whoever stored it first.
	f.public = false
	complete(a, 980004, "")
	complete(b, 980005, "")
	if downloads.Load() != 2 {
		t.Fatal("stored media downloaded again", downloads.Load())
	}
}
