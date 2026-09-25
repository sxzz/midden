package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	pb "monitor/api/adapter/v1"
	"monitor/internal/domain"
	"monitor/internal/store"
)

func TestPublicSharing(t *testing.T) {
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
	channel := uuid.NewString()
	_, e = admin.Pool.Exec(ctx, `INSERT INTO channels(id,kind,external_id) VALUES($1,'public-test',$2)`, channel, channel)
	must(t, e)
	identities := make([]domain.Identity, 3)
	for i := range identities {
		identities[i], e = db.Resolve(ctx, channel, uuid.NewString(), 1<<30)
		must(t, e)
	}
	a, b, c := identities[0].TenantID, identities[1].TenantID, identities[2].TenantID
	var img bytes.Buffer
	must(t, png.Encode(&img, image.NewRGBA(image.Rect(0, 0, 3, 3))))
	h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write(img.Bytes()) }))
	defer h.Close()
	fake := &fakeAdapter{public: true, text: "original", urls: []string{h.URL}}
	mem := &memoryBlob{m: map[string][]byte{}}
	sender := &fakeSender{}
	s := &Service{DB: db, Queue: q, Adapter: fake, Config: Defaults(), Blobs: mem, HTTP: http.DefaultClient, Sender: sender}
	target := "https://x.com/a/status/91000000001"
	jobs := make([]domain.Job, 2)
	var wg sync.WaitGroup
	for i := range jobs {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			id := identities[i]
			var err error
			jobs[i], err = s.Submit(ctx, id.TenantID, domain.CaptureInput{URL: target, Origin: domain.Origin{IdentityID: id.ID, ChannelID: channel, ChatID: id.ExternalID}})
			if err != nil {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	if t.Failed() {
		t.FailNow()
	}
	j := jobs[0]
	if j.ID != jobs[1].ID || j.ArchiveID != jobs[1].ArchiveID {
		t.Fatal("public submissions did not coalesce")
	}
	complete := func(job domain.Job) {
		var owner string
		must(t, admin.Pool.QueryRow(ctx, `SELECT tenant_id FROM captures WHERE id=$1`, job.ID).Scan(&owner))
		must(t, s.capture(ctx, store.Task{Tenant: owner, ID: job.ID}))
		var aa []domain.Asset
		must(t, db.Tx(ctx, owner, func(tx pgx.Tx) error { var err error; aa, err = assets(ctx, tx, job.ID); return err }))
		for _, asset := range aa {
			must(t, s.download(ctx, store.Task{Tenant: owner, ID: asset.ID}))
		}
		must(t, s.finalize(ctx, owner, job.ID))
	}
	complete(j)
	if fake.calls.Load() != 1 {
		t.Fatal("duplicate fetch")
	}
	for _, tenant := range []string{a, b, c} {
		ar, err := s.Archive(ctx, tenant, j.ArchiveID)
		must(t, err)
		if ar.Text != "original" || ar.Visibility != "public" {
			t.Fatal(ar)
		}
		_, err = s.Asset(ctx, tenant, ar.Assets[0].ID)
		must(t, err)
	}
	if _, e = s.Job(ctx, c, j.ID); e == nil {
		t.Fatal("unrelated public job exposed")
	}
	for _, tenant := range []string{a, b} {
		_, e = s.Job(ctx, tenant, j.ID)
		must(t, e)
	}
	page, e := s.Recent(ctx, c, "")
	must(t, e)
	if len(page.Items) != 0 {
		t.Fatal("other tenant's collection exposed")
	}
	if _, e = s.Recent(ctx, c, base64.RawURLEncoding.EncodeToString([]byte(j.ArchiveID))); e == nil {
		t.Fatal("foreign collection cursor accepted")
	}
	for _, tenant := range []string{a, b} {
		page, e = s.Recent(ctx, tenant, "")
		must(t, e)
		if len(page.Items) != 1 {
			t.Fatal(page)
		}
		var sid string
		must(t, db.Tx(ctx, tenant, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `SELECT id FROM submissions WHERE capture_id=$1`, j.ID).Scan(&sid)
		}))
		var n int
		must(t, admin.Pool.QueryRow(ctx, `SELECT count(*) FROM river_job WHERE args->>'type'='deliver' AND args->>'tenant'=$1 AND args->>'id'=$2`, tenant, sid).Scan(&n))
		if n != 1 {
			t.Fatal("delivery not scheduled for subscriber", tenant, n)
		}
		must(t, s.deliver(ctx, store.Task{Tenant: tenant, ID: sid}))
	}
	if len(sender.chats) != 2 {
		t.Fatal("expected one captioned image for each subscriber", sender.chats)
	}
	old, e := s.Archive(ctx, a, j.ArchiveID)
	must(t, e)
	refresh, e := s.Submit(ctx, b, domain.CaptureInput{RefreshID: j.ArchiveID})
	must(t, e)
	complete(refresh)
	unchanged, e := s.Archive(ctx, a, j.ArchiveID)
	must(t, e)
	if unchanged.RevisionID != old.RevisionID {
		t.Fatal("unchanged shared refresh duplicated revision")
	}
	fake.set("edited", h.URL)
	refresh, e = s.Submit(ctx, b, domain.CaptureInput{RefreshID: j.ArchiveID})
	must(t, e)
	complete(refresh)
	for _, tenant := range []string{a, b} {
		ar, err := s.Archive(ctx, tenant, j.ArchiveID)
		must(t, err)
		if ar.Text != "edited" || ar.RevisionID == old.RevisionID {
			t.Fatal("shared update missing")
		}
	}
	pinned, e := s.CaptureArchive(ctx, a, j.ID)
	must(t, e)
	if pinned.Text != "original" {
		t.Fatal("old delivery overwritten")
	}
	var n int
	must(t, admin.Pool.QueryRow(ctx, `SELECT count(*) FROM revisions WHERE archive_id=$1`, j.ArchiveID).Scan(&n))
	if n != 2 {
		t.Fatal("revision duplication", n)
	}
	must(t, admin.Pool.QueryRow(ctx, `SELECT count(*) FROM blobs WHERE visibility='public' AND hash=$1`, store.Hash(img.String())).Scan(&n))
	if n != 1 {
		t.Fatal("public blob duplication", n)
	}
	for _, tenant := range []string{a, b} {
		must(t, s.Collect(ctx, tenant, 0))
		u, err := s.Usage(ctx, tenant)
		must(t, err)
		if u.Reserved != 0 {
			t.Fatal("reservation leak")
		}
	}
	mem.mu.Lock()
	objects := len(mem.m)
	mem.mu.Unlock()
	if objects != 1 {
		t.Fatal("duplicate stored images", objects)
	}
	// Each subscriber is charged for its references, without another physical copy or fetch.
	before := fake.calls.Load()
	reuse, e := s.Submit(ctx, c, domain.CaptureInput{URL: target})
	must(t, e)
	if reuse.ArchiveID != j.ArchiveID || fake.calls.Load() != before {
		t.Fatal("public reuse failed")
	}
	u, e := s.Usage(ctx, c)
	must(t, e)
	ua, e := s.Usage(ctx, a)
	must(t, e)
	ub, e := s.Usage(ctx, b)
	must(t, e)
	if u.Used <= 0 || u.Used != ua.Used || u.Used != ub.Used || u.Reserved != 0 {
		t.Fatal("logical usage differs", ua, ub, u)
	}
	// Removing the original subscriber releases only that tenant's references.
	must(t, s.DeleteArchive(ctx, a, j.ArchiveID))
	ua, e = s.Usage(ctx, a)
	must(t, e)
	ub, e = s.Usage(ctx, b)
	must(t, e)
	if ua.Used != 0 || ub.Used != u.Used {
		t.Fatal("forget changed another subscriber's usage", ua, ub)
	}
	_, e = s.Archive(ctx, b, j.ArchiveID)
	must(t, e)
	// Existing shared content cannot be added when the tenant lacks logical quota.
	_, e = admin.Pool.Exec(ctx, `UPDATE tenants SET quota_bytes=1 WHERE id=$1`, a)
	must(t, e)
	if _, e = s.Submit(ctx, a, domain.CaptureInput{URL: target}); e != domain.ErrQuota {
		t.Fatal("reused content bypassed quota", e)
	}
	_, e = admin.Pool.Exec(ctx, `UPDATE tenants SET quota_bytes=$2 WHERE id=$1`, c, u.Used)
	must(t, e)
	fake.set("larger shared update", h.URL)
	next, e := s.Submit(ctx, b, domain.CaptureInput{RefreshID: j.ArchiveID})
	must(t, e)
	complete(next)
	over, e := s.Usage(ctx, c)
	must(t, e)
	if over.Used <= over.Limit {
		t.Fatal("shared update not charged", over)
	}
	if _, e = s.Submit(ctx, c, domain.CaptureInput{URL: "https://x.com/a/status/91000000009"}); e != domain.ErrQuota {
		t.Fatal("over-quota tenant started new work", e)
	}
	must(t, s.DeleteArchive(ctx, c, j.ArchiveID))
	empty, e := s.Usage(ctx, c)
	must(t, e)
	if empty.Used != 0 {
		t.Fatal("forget did not release logical usage", empty)
	}
	_, e = admin.Pool.Exec(ctx, `UPDATE tenants SET quota_bytes=1073741824 WHERE id=$1`, a)
	must(t, e)

	// Same target and image under a private provider are isolated from public and other tenants.
	private := *s
	private.Adapter = &fakeAdapter{text: "secret", urls: []string{h.URL}}
	pj, e := private.Submit(ctx, a, domain.CaptureInput{URL: target})
	must(t, e)
	if pj.ArchiveID == j.ArchiveID {
		t.Fatal("private/public merged")
	}
	s.Adapter = private.Adapter
	complete(pj)
	s.Adapter = fake
	pa, e := s.Archive(ctx, a, pj.ArchiveID)
	must(t, e)
	if pa.Visibility != "private" {
		t.Fatal(pa)
	}
	if _, e = s.Archive(ctx, b, pj.ArchiveID); e == nil {
		t.Fatal("private archive exposed")
	}
	if _, e = s.Asset(ctx, b, pa.Assets[0].ID); e == nil {
		t.Fatal("private asset exposed")
	}
	if pa.Assets[0].Key == old.Assets[0].Key {
		t.Fatal("private/public blob merged")
	}
	p2, e := private.Submit(ctx, b, domain.CaptureInput{URL: target})
	must(t, e)
	if p2.ArchiveID == pj.ArchiveID {
		t.Fatal("private tenants merged")
	}
	s.Adapter = private.Adapter
	complete(p2)
	s.Adapter = fake
	pbArchive, e := s.Archive(ctx, b, p2.ArchiveID)
	must(t, e)
	if pbArchive.Assets[0].Key == pa.Assets[0].Key {
		t.Fatal("private image shared across tenants")
	}
	// RLS rejects fabricated links even when the attacker knows a private UUID.
	e = db.Tx(ctx, b, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO tenant_archives(tenant_id,archive_id) VALUES($1,$2)`, b, pj.ArchiveID)
		return err
	})
	if e == nil {
		t.Fatal("private collection link accepted")
	}
	e = db.Tx(ctx, b, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO submissions(tenant_id,capture_id,idem_key,fingerprint) VALUES($1,$2,'forged','forged')`, b, pj.ID)
		return err
	})
	if e == nil {
		t.Fatal("private submission link accepted")
	}
	// The same tenant pays once for a Blob shared by multiple archived posts.
	beforeUsage, e := s.Usage(ctx, b)
	must(t, e)
	second, e := s.Submit(ctx, b, domain.CaptureInput{URL: "https://x.com/a/status/91000000003"})
	must(t, e)
	complete(second)
	var textBytes int64
	must(t, admin.Pool.QueryRow(ctx, `SELECT sum(content_bytes) FROM revisions WHERE archive_id=$1`, second.ArchiveID).Scan(&textBytes))
	afterUsage, e := s.Usage(ctx, b)
	must(t, e)
	if afterUsage.Used-beforeUsage.Used != textBytes {
		t.Fatal("image counted twice across the tenant's collections", beforeUsage, afterUsage, textBytes)
	}
	secondArchive, e := s.Archive(ctx, b, second.ArchiveID)
	must(t, e)
	// The last removal starts delayed cleanup; other references must survive.
	must(t, s.DeleteArchive(ctx, b, j.ArchiveID))
	var removed int
	must(t, admin.Pool.QueryRow(ctx, `SELECT collect_unreferenced_archives(interval '24 hours')`).Scan(&removed))
	if removed != 0 {
		t.Fatal("archive cleaned before grace")
	}
	must(t, admin.Pool.QueryRow(ctx, `SELECT collect_unreferenced_archives(interval '0 seconds')`).Scan(&removed))
	must(t, admin.Pool.QueryRow(ctx, `SELECT count(*) FROM archives WHERE id=$1`, j.ArchiveID).Scan(&n))
	if n != 0 {
		t.Fatal("unreferenced archive not removed")
	}
	for _, tenant := range []string{a, b, c} {
		must(t, s.Collect(ctx, tenant, 0))
	}
	if _, e = s.Archive(ctx, b, j.ArchiveID); e == nil {
		t.Fatal("orphan archive remained")
	}
	_, e = s.Asset(ctx, a, pa.Assets[0].ID)
	must(t, e)
	_, e = s.Asset(ctx, b, pbArchive.Assets[0].ID)
	must(t, e)
	_, e = s.Asset(ctx, b, secondArchive.Assets[0].ID)
	must(t, e)
	if _, e = mem.Get(ctx, secondArchive.Assets[0].Key); e != nil {
		t.Fatal("shared image removed while another archive referenced it", e)
	}
	must(t, s.DeleteArchive(ctx, b, second.ArchiveID))
	must(t, admin.Pool.QueryRow(ctx, `SELECT collect_unreferenced_archives(interval '0 seconds')`).Scan(&removed))
	must(t, admin.Pool.QueryRow(ctx, `SELECT count(*) FROM archives WHERE id=$1`, second.ArchiveID).Scan(&n))
	if n != 0 {
		t.Fatal("last shared reference not collected")
	}
	// Removing a collection during capture must not destroy its running task or recreate the collection.
	inflight, e := s.Submit(ctx, a, domain.CaptureInput{URL: "https://x.com/a/status/91000000004"})
	must(t, e)
	must(t, s.DeleteArchive(ctx, a, inflight.ArchiveID))
	must(t, admin.Pool.QueryRow(ctx, `SELECT collect_unreferenced_archives(interval '0 seconds')`).Scan(&removed))
	must(t, admin.Pool.QueryRow(ctx, `SELECT count(*) FROM archives WHERE id=$1`, inflight.ArchiveID).Scan(&n))
	if n != 1 {
		t.Fatal("in-flight archive collected")
	}
	complete(inflight)
	must(t, admin.Pool.QueryRow(ctx, `SELECT collect_unreferenced_archives(interval '0 seconds')`).Scan(&removed))
	must(t, admin.Pool.QueryRow(ctx, `SELECT count(*) FROM archives WHERE id=$1`, inflight.ArchiveID).Scan(&n))
	if n != 0 {
		t.Fatal("finished unreferenced archive not collected")
	}
	// A provider policy mismatch must fail before publishing any text or image.
	s.Providers = []*pb.Provider{{Id: "fxtwitter", Authentication: "none", Visibility: pb.Visibility_VISIBILITY_PUBLIC}}
	mismatch, e := s.Submit(ctx, a, domain.CaptureInput{URL: "https://x.com/a/status/91000000002"})
	must(t, e)
	s.Adapter = private.Adapter
	if e = s.capture(ctx, store.Task{Tenant: a, ID: mismatch.ID}); e == nil {
		t.Fatal("private response published as public")
	}
	s.Providers = []*pb.Provider{{Id: "fxtwitter", Authentication: "none"}}
	if _, e = s.Submit(ctx, a, domain.CaptureInput{URL: target}); e == nil {
		t.Fatal("unspecified visibility accepted")
	}
}
