package app

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
	"github.com/minio/minio-go/v7"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	"monitor/internal/blob"
	"monitor/internal/domain"
	"monitor/internal/store"
)

type restoreRecord struct {
	Tenant, Archive, Asset, Channel, Identity, Key, MIME, Hash string
	Size                                                       int64
}

func TestBackupRestore(t *testing.T) {
	phase := os.Getenv("TEST_RESTORE_PHASE")
	dir := os.Getenv("TEST_RESTORE_DIR")
	if phase == "" || dir == "" {
		t.Skip("restore drill is run by scripts/test-integration.sh")
	}
	ctx := context.Background()
	admin, e := store.Open(ctx, os.Getenv("TEST_ADMIN_DATABASE_URL"))
	must(t, e)
	defer admin.Close()
	db, e := store.Open(ctx, os.Getenv("TEST_DATABASE_URL"))
	must(t, e)
	defer db.Close()
	storage, e := blob.New(os.Getenv("TEST_S3_ENDPOINT"), "monitor-test", "monitor-test-secret", "restore-"+phase)
	must(t, e)
	exists, e := storage.Client.BucketExists(ctx, storage.Bucket)
	must(t, e)
	if !exists {
		must(t, storage.Client.MakeBucket(ctx, storage.Bucket, minio.MakeBucketOptions{}))
	}
	q, e := river.NewClient(riverpgxv5.New(db.Pool), &river.Config{})
	must(t, e)
	s := &Service{DB: db, Queue: q, Blobs: storage, Config: Defaults(), HTTP: http.DefaultClient}
	path := filepath.Join(dir, "record.json")
	imagePath := filepath.Join(dir, "original.png")
	if phase == "prepare" {
		channel := uuid.NewString()
		_, e = admin.Pool.Exec(ctx, `INSERT INTO channels(id,kind,external_id) VALUES($1,'restore',$2)`, channel, channel)
		must(t, e)
		identity, e := db.Resolve(ctx, channel, "restore-user", 1<<30)
		must(t, e)
		var pngBytes bytes.Buffer
		must(t, png.Encode(&pngBytes, image.NewRGBA(image.Rect(0, 0, 4, 4))))
		h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write(pngBytes.Bytes()) }))
		defer h.Close()
		s.Adapter = &fakeAdapter{text: "backup restoration fixture", urls: []string{h.URL}}
		j, e := s.Submit(ctx, identity.TenantID, domain.CaptureInput{URL: "https://x.com/a/status/555"})
		must(t, e)
		must(t, s.capture(ctx, store.Task{Tenant: identity.TenantID, ID: j.ID}))
		var aid string
		must(t, admin.Pool.QueryRow(ctx, `SELECT id FROM assets WHERE capture_id=$1`, j.ID).Scan(&aid))
		must(t, s.download(ctx, store.Task{Tenant: identity.TenantID, ID: aid}))
		must(t, s.finalize(ctx, identity.TenantID, j.ID))
		asset, e := s.Asset(ctx, identity.TenantID, aid)
		must(t, e)
		record := restoreRecord{Tenant: identity.TenantID, Archive: j.ArchiveID, Asset: aid, Channel: channel, Identity: identity.ID, Key: asset.Key, MIME: asset.MIME, Size: asset.Size, Hash: store.Hash(string(pngBytes.Bytes()))}
		raw, _ := json.Marshal(record)
		must(t, os.WriteFile(path, raw, 0o600))
		body, e := storage.Get(ctx, asset.Key)
		must(t, e)
		data, e := io.ReadAll(body)
		body.Close()
		must(t, e)
		must(t, os.WriteFile(imagePath, data, 0o600))
		t.Log("prepared database and original S3 object for backup")
		return
	}
	var record restoreRecord
	raw, e := os.ReadFile(path)
	must(t, e)
	must(t, json.Unmarshal(raw, &record))
	data, e := os.ReadFile(imagePath)
	must(t, e)
	must(t, storage.Put(ctx, record.Key, bytes.NewReader(data), record.Size, record.MIME))
	identity, e := db.Resolve(ctx, record.Channel, "restore-user", 1<<30)
	must(t, e)
	if identity.ID != record.Identity || identity.TenantID != record.Tenant {
		t.Fatal("restored identity mismatch")
	}
	archive, e := s.Archive(ctx, record.Tenant, record.Archive)
	must(t, e)
	if archive.Text != "backup restoration fixture" {
		t.Fatal("restored text mismatch")
	}
	asset, e := s.Asset(ctx, record.Tenant, record.Asset)
	must(t, e)
	body, e := storage.Get(ctx, asset.Key)
	must(t, e)
	actual, e := io.ReadAll(body)
	body.Close()
	must(t, e)
	if store.Hash(string(actual)) != record.Hash {
		t.Fatal("restored object checksum mismatch")
	}
	var other string
	must(t, admin.Pool.QueryRow(ctx, `INSERT INTO tenants DEFAULT VALUES RETURNING id`).Scan(&other))
	if _, e = s.Archive(ctx, other, record.Archive); e == nil {
		t.Fatal("restored RLS broken")
	}
	if _, e = s.Asset(ctx, other, record.Asset); e == nil {
		t.Fatal("restored asset authorization broken")
	}
	t.Log("verified restored DB, identity, archive, isolated S3 bucket and tenant isolation")
}
