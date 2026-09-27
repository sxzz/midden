package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/minio/minio-go/v7"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"google.golang.org/grpc"
	"google.golang.org/protobuf/proto"

	pb "monitor/api/adapter/v1"
	"monitor/internal/blob"
	"monitor/internal/domain"
	"monitor/internal/store"
)

type fakeAdapter struct {
	graph           *pb.EntityGraph
	entityTypes     []*pb.EntityType
	extraResources  []*pb.Resource
	sourceResponses []*pb.SourceResponse
	mu              sync.Mutex
	public          bool
	text            string
	textSource      string
	incomplete      bool
	urls            []string
	mediaKind       string
	cacheKey        string
	altText         string
	sensitive       bool
	calls           atomic.Int64
}

func (f *fakeAdapter) Describe(context.Context, *pb.DescribeRequest, ...grpc.CallOption) (*pb.DescribeResponse, error) {
	visibility := pb.Visibility_VISIBILITY_PRIVATE
	if f.public {
		visibility = pb.Visibility_VISIBILITY_PUBLIC
	}
	d := &pb.DescribeResponse{EntityTypes: f.entityTypes, ProtocolVersion: "1.0", AdapterId: "fixture", Providers: []*pb.Provider{{Id: "fxtwitter", Capabilities: []*pb.Capability{{Name: "capture.fetch", Major: 1}}, Authentication: "none", Visibilities: []pb.Visibility{visibility}}}}
	if f.graph != nil {
		d.Providers[0].Capabilities = append(d.Providers[0].Capabilities, &pb.Capability{Name: "entity.graph", Major: 1})
		for _, t := range f.entityTypes {
			d.Providers[0].EntityTypes = append(d.Providers[0].EntityTypes, t.Name)
		}
	}
	return d, nil
}

func (f *fakeAdapter) Fetch(ctx context.Context, r *pb.FetchRequest, _ ...grpc.CallOption) (*pb.FetchResponse, error) {
	f.calls.Add(1)
	f.mu.Lock()
	defer f.mu.Unlock()
	visibility := pb.Visibility_VISIBILITY_PRIVATE
	if f.public {
		visibility = pb.Visibility_VISIBILITY_PUBLIC
	}
	v := &pb.FetchResponse{AuthorName: "作者", PublishedAt: "2026-04-05T03:22:33Z", Summary: "作者：" + f.text, Graph: f.graph, SourceResponses: f.sourceResponses, Visibility: visibility, ExternalId: r.ExternalId, ProviderId: r.ProviderId, Text: f.text, TextKind: "provider_summary", AdapterVersion: "test", Warnings: []string{"incomplete"}, TextSource: f.textSource, Incomplete: f.incomplete}
	if f.graph != nil {
		v.Graph = proto.Clone(f.graph).(*pb.EntityGraph)
		for _, entity := range v.Graph.Entities {
			if entity.Key == v.Graph.Root {
				entity.ExternalId = r.ExternalId
			}
		}
	}
	v.Resources = append(v.Resources, f.extraResources...)
	for _, u := range f.urls {
		v.Resources = append(v.Resources, &pb.Resource{Url: u, ImmutableKey: f.cacheKey, AltText: f.altText, Sensitive: f.sensitive, Kind: func() string {
			if f.mediaKind != "" {
				return f.mediaKind
			}
			return "image"
		}()})
	}
	return v, nil
}

func (f *fakeAdapter) set(text string, urls ...string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.text = text
	f.urls = urls
}

type memoryBlob struct {
	mu           sync.Mutex
	m            map[string][]byte
	puts         atomic.Int64
	failAfterPut atomic.Bool
}

func (b *memoryBlob) Put(_ context.Context, k string, r io.Reader, _ int64, _ string) error {
	v, e := io.ReadAll(r)
	if e != nil {
		return e
	}
	b.mu.Lock()
	b.m[k] = v
	b.mu.Unlock()
	b.puts.Add(1)
	if b.failAfterPut.Swap(false) {
		return fmt.Errorf("simulated crash after object write")
	}
	return nil
}

func (b *memoryBlob) Get(_ context.Context, k string) (io.ReadCloser, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	v, ok := b.m[k]
	if !ok {
		return nil, fmt.Errorf("missing object")
	}
	return io.NopCloser(bytes.NewReader(v)), nil
}

func (b *memoryBlob) Delete(_ context.Context, k string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.m, k)
	return nil
}

type fakeSender struct {
	mu    sync.Mutex
	chats []string
	count int64
}

func (f *fakeSender) Send(_ context.Context, chat, text string, mid int64) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.chats = append(f.chats, chat)
	f.count++
	return f.count, nil
}

func (f *fakeSender) MediaItem(ctx context.Context, chat string, a domain.Asset) (int64, error) {
	return f.Send(ctx, chat, a.ID, 0)
}

func TestIntegration(t *testing.T) {
	adminDSN := os.Getenv("TEST_ADMIN_DATABASE_URL")
	appDSN := os.Getenv("TEST_DATABASE_URL")
	if adminDSN == "" || appDSN == "" {
		t.Skip("run scripts/test-integration.sh (Docker PostgreSQL required)")
	}
	ctx := context.Background()
	admin, e := store.Open(ctx, adminDSN)
	must(t, e)
	defer admin.Close()
	db, e := store.Open(ctx, appDSN)
	must(t, e)
	defer db.Close()
	must(t, db.CheckRole(ctx))
	if e = admin.CheckRole(ctx); e == nil {
		t.Fatal("admin accepted as runtime")
	}
	fake := &fakeAdapter{text: "hello"}
	mem := &memoryBlob{m: map[string][]byte{}}
	sender := &fakeSender{}
	cfg := Defaults()
	cfg.Rate = 10000
	s := &Service{DB: db, Adapter: fake, Blobs: mem, HTTP: http.DefaultClient, Config: cfg, Sender: sender}
	workers := river.NewWorkers()
	river.AddWorker(workers, &Worker{S: s})
	queue, e := river.NewClient(riverpgxv5.New(db.Pool), &river.Config{Workers: workers, Queues: map[string]river.QueueConfig{"capture": {MaxWorkers: 4}, "download": {MaxWorkers: 8}, "control": {MaxWorkers: 4}, "delivery": {MaxWorkers: 2}}, FetchPollInterval: 100 * time.Millisecond, FetchCooldown: 10 * time.Millisecond})
	must(t, e)
	s.Queue = queue
	newTenant := func() string {
		var id string
		must(t, admin.Pool.QueryRow(ctx, `INSERT INTO tenants DEFAULT VALUES RETURNING id`).Scan(&id))
		return id
	}
	newChannel := func() string {
		id := uuid.NewString()
		_, e := admin.Pool.Exec(ctx, `INSERT INTO channels(id,kind,external_id) VALUES($1,'test',$2)`, id, id)
		must(t, e)
		return id
	}
	ch1, ch2 := newChannel(), newChannel()
	var ids [20]domain.Identity
	var wg sync.WaitGroup
	for i := range ids {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			v, err := db.Resolve(ctx, ch1, "42", cfg.Quota)
			if err != nil {
				t.Error(err)
			}
			ids[i] = v
		}(i)
	}
	wg.Wait()
	tenant := ids[0].TenantID
	for _, id := range ids {
		if id.ID != ids[0].ID || id.TenantID != tenant {
			t.Fatal("identity race")
		}
	}
	other, e := db.Resolve(ctx, ch2, "42", cfg.Quota)
	must(t, e)
	if other.TenantID == tenant {
		t.Fatal("identities crossed channel boundary")
	}
	var second string
	must(t, admin.Pool.QueryRow(ctx, `INSERT INTO identities(tenant_id,channel_id,external_id) VALUES($1,$2,'99') RETURNING id`, tenant, ch2).Scan(&second))
	origin1 := domain.Origin{IdentityID: ids[0].ID, ChannelID: ch1, ChatID: "42"}
	origin2 := domain.Origin{IdentityID: second, ChannelID: ch2, ChatID: "99"}
	var jobs [20]domain.Job
	for i := range jobs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			o := origin1
			if i%2 == 1 {
				o = origin2
			}
			v, err := s.Submit(ctx, tenant, domain.CaptureInput{URL: "https://x.com/u/status/20", Key: fmt.Sprint(i), Origin: o})
			if err != nil {
				t.Error(err)
			}
			jobs[i] = v
		}(i)
	}
	wg.Wait()
	j := jobs[0]
	for _, v := range jobs {
		if v.ID != j.ID {
			t.Fatal("inflight work not coalesced")
		}
	}
	must(t, s.capture(ctx, store.Task{Tenant: tenant, ID: j.ID, Type: "capture"}))
	must(t, s.finalize(ctx, tenant, j.ID))
	a, e := s.Archive(ctx, tenant, j.ArchiveID)
	must(t, e)
	if a.Text != "hello" || a.Summary != "作者：hello" || a.AuthorName != "作者" || a.PublishedAt != "2026-04-05T03:22:33Z" {
		t.Fatal(a)
	}
	recent := &commandRequest{Task: store.Task{Tenant: tenant}}
	must(t, s.commandRecent(ctx, recent))
	if len(recent.Entities) != 1 || recent.Entities[0].URL != a.URL || recent.Entities[0].Offset != 3 || recent.Entities[0].Length != 8 {
		t.Fatal("missing summary source link", recent.Entities)
	}
	if recent.Text != "1. 作者：hello" || len(recent.Buttons) != 1 || recent.Buttons[0][0].Data != "/show "+a.ID || len(recent.Buttons[0]) != 2 || recent.Buttons[0][1].URL != a.URL {
		t.Fatalf("unexpected recent list: %+v", recent)
	}
	// Reloaded app has no in-memory task state; redo persisted capture/finalize safely.
	restarted := *s
	must(t, restarted.capture(ctx, store.Task{Tenant: tenant, ID: j.ID}))
	must(t, restarted.finalize(ctx, tenant, j.ID))
	if fake.calls.Load() != 1 {
		t.Fatal("completed capture re-fetched")
	}
	for _, fn := range []func() error{func() error { _, e := s.Archive(ctx, other.TenantID, a.ID); return e }, func() error { _, e := s.Job(ctx, other.TenantID, j.ID); return e }} {
		if fn() == nil {
			t.Fatal("cross tenant data exposed")
		}
	}
	var n int
	must(t, db.Pool.QueryRow(ctx, `SELECT count(*) FROM archives`).Scan(&n))
	if n != 0 {
		t.Fatal("RLS missing without context")
	}
	var subIDs []string
	must(t, db.Tx(ctx, tenant, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx, `SELECT id FROM submissions WHERE capture_id=$1`, j.ID)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var id string
			if e = rows.Scan(&id); e != nil {
				return e
			}
			subIDs = append(subIDs, id)
		}
		return rows.Err()
	}))
	for _, id := range subIDs {
		must(t, s.deliver(ctx, store.Task{Tenant: tenant, ID: id}))
		must(t, s.deliver(ctx, store.Task{Tenant: tenant, ID: id}))
	}
	if len(sender.chats) != 20 {
		t.Fatalf("unexpected deliveries %d", len(sender.chats))
	}
	oldRevision := a.RevisionID
	refresh := func() domain.Archive {
		v, err := s.Submit(ctx, tenant, domain.CaptureInput{RefreshID: a.ID})
		must(t, err)
		must(t, s.capture(ctx, store.Task{Tenant: tenant, ID: v.ID}))
		must(t, s.finalize(ctx, tenant, v.ID))
		v2, err := s.Archive(ctx, tenant, a.ID)
		must(t, err)
		return v2
	}
	if refresh().RevisionID != oldRevision {
		t.Fatal("unchanged revision duplicated")
	}
	fake.set("edited")
	if refresh().RevisionID == oldRevision {
		t.Fatal("changed content missing revision")
	}
	pinned, e := s.CaptureArchive(ctx, tenant, j.ID)
	must(t, e)
	if pinned.Text != "hello" || pinned.Summary != "作者：hello" || pinned.AuthorName != "作者" || pinned.PublishedAt != "2026-04-05T03:22:33Z" {
		t.Fatal("delivery snapshot changed")
	}
	// Connection ownership and account auth rejection.
	var connection string
	must(t, admin.Pool.QueryRow(ctx, `INSERT INTO connections(tenant_id,adapter_id,provider_id,name,state) VALUES($1,'x','account','test','ready') RETURNING id`, tenant).Scan(&connection))
	if _, e = s.Submit(ctx, other.TenantID, domain.CaptureInput{URL: a.URL, ConnectionID: connection}); e == nil {
		t.Fatal("cross tenant connection accepted")
	}
	if _, e = s.Submit(ctx, tenant, domain.CaptureInput{URL: a.URL, ConnectionID: connection}); !errors.Is(e, domain.ErrUnsupported) {
		t.Fatal(e)
	}
	// Image storage, interrupted upload, dedup and quota reservations.
	var imageData bytes.Buffer
	must(t, png.Encode(&imageData, image.NewRGBA(image.Rect(0, 0, 2, 2))))
	h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		w.Write(imageData.Bytes())
	}))
	defer h.Close()
	fake.set("with image", h.URL+"/one", h.URL+"/two")
	imageTenant := newTenant()
	v, e := s.Submit(ctx, imageTenant, domain.CaptureInput{URL: "https://x.com/a/status/30"})
	must(t, e)
	must(t, s.capture(ctx, store.Task{Tenant: imageTenant, ID: v.ID}))
	var aa []domain.Asset
	must(t, db.Tx(ctx, imageTenant, func(tx pgx.Tx) error { var e error; aa, e = assets(ctx, tx, v.ID); return e }))
	mem.failAfterPut.Store(true)
	if e = s.download(ctx, store.Task{Tenant: imageTenant, ID: aa[0].ID}); e == nil {
		t.Fatal("expected interrupted upload")
	}
	u, e := s.Usage(ctx, imageTenant)
	must(t, e)
	if u.Reserved == 0 {
		t.Fatal("reservation lost")
	}
	for _, asset := range aa {
		must(t, s.download(ctx, store.Task{Tenant: imageTenant, ID: asset.ID}))
		must(t, s.download(ctx, store.Task{Tenant: imageTenant, ID: asset.ID}))
	}
	must(t, s.finalize(ctx, imageTenant, v.ID))
	imgArc, e := s.Archive(ctx, imageTenant, v.ArchiveID)
	must(t, e)
	if len(imgArc.Assets) != 2 || imgArc.Assets[0].Hash != imgArc.Assets[1].Hash {
		t.Fatal(imgArc)
	}
	u, e = s.Usage(ctx, imageTenant)
	must(t, e)
	if u.Reserved != 0 {
		t.Fatal("leaked reservation")
	}
	must(t, s.Collect(ctx, imageTenant, 0))
	must(t, db.Tx(ctx, imageTenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT count(*) FROM blobs WHERE tenant_id=$1 AND visibility='private'`, imageTenant).Scan(&n)
	}))
	if n != 1 {
		t.Fatal("file not deduplicated")
	}
	if _, e = s.Asset(ctx, tenant, imgArc.Assets[0].ID); e == nil {
		t.Fatal("cross tenant image")
	}

	// Concurrent unknown-size image reservations cannot overrun the tenant budget.
	smallTenant := newTenant()
	_, e = admin.Pool.Exec(ctx, `UPDATE tenants SET quota_bytes=1024 WHERE id=$1`, smallTenant)
	must(t, e)
	small, e := s.Submit(ctx, smallTenant, domain.CaptureInput{URL: "https://x.com/a/status/31"})
	must(t, e)
	must(t, s.capture(ctx, store.Task{Tenant: smallTenant, ID: small.ID}))
	var smallAssets []domain.Asset
	must(t, db.Tx(ctx, smallTenant, func(tx pgx.Tx) error { var e error; smallAssets, e = assets(ctx, tx, small.ID); return e }))
	for _, asset := range smallAssets {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			err := s.download(ctx, store.Task{Tenant: smallTenant, ID: id})
			if err != nil {
				if e := s.fail(ctx, store.Task{Tenant: smallTenant, ID: id, Type: "download"}, safeError(err)); e != nil {
					t.Error(e)
				}
			}
		}(asset.ID)
	}
	wg.Wait()
	must(t, s.finalize(ctx, smallTenant, small.ID))
	smallUsage, e := s.Usage(ctx, smallTenant)
	must(t, e)
	if smallUsage.Reserved != 0 || smallUsage.Used > smallUsage.Limit {
		t.Fatalf("quota race: %+v", smallUsage)
	}
	// A worker killed on its final attempt is reconciled from River's terminal state.
	crashTenant := newTenant()
	crashed, e := s.Submit(ctx, crashTenant, domain.CaptureInput{URL: "https://x.com/a/status/32"})
	must(t, e)
	must(t, s.capture(ctx, store.Task{Tenant: crashTenant, ID: crashed.ID}))
	var abandoned string
	must(t, admin.Pool.QueryRow(ctx, `SELECT id FROM assets WHERE capture_id=$1 LIMIT 1`, crashed.ID).Scan(&abandoned))
	mem.failAfterPut.Store(true)
	if s.download(ctx, store.Task{Tenant: crashTenant, ID: abandoned}) == nil {
		t.Fatal("expected interruption")
	}
	_, e = admin.Pool.Exec(ctx, `UPDATE river_job SET state='discarded',finalized_at=now() WHERE args->>'id'=$1 AND args->>'type'='download'`, abandoned)
	must(t, e)
	must(t, s.Maintain(ctx))
	var assetState string
	must(t, admin.Pool.QueryRow(ctx, `SELECT state FROM assets WHERE id=$1`, abandoned).Scan(&assetState))
	if assetState != "failed" {
		t.Fatal("terminal failure not reconciled")
	}
	// Pagination cursors cannot cross tenants even when they contain a valid UUID.
	if _, e = s.Recent(ctx, other.TenantID, base64.RawURLEncoding.EncodeToString([]byte(a.ID))); e == nil {
		t.Fatal("cross-tenant cursor accepted")
	}
	// No in-memory rate limit: two channel identities consume the same tenant counter.
	oldRate := s.Config.Rate
	s.Config.Rate = 1
	_, e = admin.Pool.Exec(ctx, `UPDATE tenants SET rate_count=0,rate_start=now() WHERE id=$1`, tenant)
	must(t, e)
	_, e = s.Submit(ctx, tenant, domain.CaptureInput{URL: "https://x.com/a/status/80", Origin: origin1})
	must(t, e)
	_, e = s.Submit(ctx, tenant, domain.CaptureInput{URL: "https://x.com/a/status/81", Origin: origin2})
	if e != domain.ErrRate {
		t.Fatalf("shared rate %v", e)
	}
	s.Config.Rate = oldRate
	// Authenticated S3-compatible backend roundtrip (Docker service).
	if endpoint := os.Getenv("TEST_S3_ENDPOINT"); endpoint != "" {
		b, err := blob.New(endpoint, "monitor-test", "monitor-test-secret", "integration")
		must(t, err)
		exists, err := b.Client.BucketExists(ctx, b.Bucket)
		must(t, err)
		if !exists {
			must(t, b.Client.MakeBucket(ctx, b.Bucket, minio.MakeBucketOptions{}))
		}
		key := uuid.NewString()
		must(t, b.Put(ctx, key, bytes.NewReader(imageData.Bytes()), int64(imageData.Len()), "image/png"))
		r, err := b.Get(ctx, key)
		must(t, err)
		out, err := io.ReadAll(r)
		r.Close()
		must(t, err)
		if !bytes.Equal(out, imageData.Bytes()) {
			t.Fatal("S3 corruption")
		}
		must(t, b.Delete(ctx, key))
	}
	// Queue integration: 100 tenants, 1000 captures, real River scheduling and draining.
	fake.set("load test")
	tenants := make([]string, 100)
	for i := range tenants {
		tenants[i] = newTenant()
	}
	for _, tenant := range tenants {
		for i := 0; i < 10; i++ {
			_, err := s.Submit(ctx, tenant, domain.CaptureInput{URL: fmt.Sprintf("https://x.com/a/status/%d", 100000+i)})
			must(t, err)
		}
	}
	workCtx, cancel := context.WithCancel(ctx)
	must(t, queue.Start(workCtx))
	defer cancel()
	deadline := time.Now().Add(60 * time.Second)
	for {
		must(t, admin.Pool.QueryRow(ctx, `SELECT count(*) FROM captures WHERE tenant_id=ANY($1::uuid[]) AND state NOT IN('complete','partial','failed')`, tenants).Scan(&n))
		if n == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("queue did not drain: %d", n)
		}
		time.Sleep(100 * time.Millisecond)
	}
	must(t, admin.Pool.QueryRow(ctx, `SELECT count(*) FROM captures WHERE tenant_id=ANY($1::uuid[]) AND state='complete'`, tenants).Scan(&n))
	if n != 1000 {
		t.Fatalf("completed %d", n)
	}
	stopCtx, stop := context.WithTimeout(ctx, 20*time.Second)
	defer stop()
	must(t, queue.Stop(stopCtx))
	t.Log("100 tenants / 1000 captures drained")
	// Inbox survives process replacement; fixture verifies private-channel origin resolution.
	update := map[string]any{"update_id": 7, "message": map[string]any{"message_id": 1, "from": map[string]any{"id": 42}, "chat": map[string]any{"id": 42, "type": "private"}, "text": "/usage"}}
	raw, _ := json.Marshal(update)
	var inbox string
	must(t, admin.Pool.QueryRow(ctx, `INSERT INTO inbox(tenant_id,channel_id,update_id,payload) VALUES($1,$2,7,$3) RETURNING id`, tenant, ch1, raw).Scan(&inbox))
	must(t, restarted.processInbox(ctx, store.Task{Tenant: tenant, ID: inbox}))
	must(t, restarted.processInbox(ctx, store.Task{Tenant: tenant, ID: inbox}))
	must(t, admin.Pool.QueryRow(ctx, `SELECT count(*) FROM replies WHERE inbox_id=$1`, inbox).Scan(&n))
	if n != 1 {
		t.Fatal("inbox duplicate reply")
	}
}

func must(t *testing.T, e error) {
	t.Helper()
	if e != nil {
		t.Fatal(e)
	}
}

func (f *fakeSender) Media(ctx context.Context, chat string, aa []domain.Asset, caption string) (int64, error) {
	return f.Send(ctx, chat, "album", 0)
}

func (f *fakeAdapter) CheckConnection(context.Context, *pb.CheckConnectionRequest, ...grpc.CallOption) (*pb.CheckConnectionResponse, error) {
	return &pb.CheckConnectionResponse{AccountId: "123", Username: "fixture"}, nil
}
