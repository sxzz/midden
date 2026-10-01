package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "monitor/api/adapter/v1"
	"monitor/internal/domain"
	"monitor/internal/store"
)

func TestWebCollection(t *testing.T) {
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
	_, e = admin.Pool.Exec(ctx, `INSERT INTO channels(id,kind,external_id) VALUES($1,'test',$2)`, channel, channel)
	must(t, e)
	a, e := db.Resolve(ctx, channel, "a", 1<<30)
	must(t, e)
	b, e := db.Resolve(ctx, channel, "b", 1<<30)
	must(t, e)
	fake := &fakeAdapter{public: true, text: "中文收藏 100%"}
	s := &Service{DB: db, Queue: q, Adapter: fake, Config: Defaults(), Blobs: &memoryBlob{m: map[string][]byte{}}}
	s.Config.Rate = 1000
	var jobs []domain.Job
	for i := 0; i < 22; i++ {
		j, e := s.Submit(ctx, a.TenantID, domain.CaptureInput{URL: fmt.Sprintf("https://x.com/a/status/%d", time.Now().UnixNano())})
		must(t, e)
		must(t, s.capture(ctx, store.Task{Tenant: a.TenantID, ID: j.ID}))
		must(t, s.finalize(ctx, a.TenantID, j.ID))
		jobs = append(jobs, j)
	}
	testAnnotations(t, s, admin, a.TenantID, b.TenantID, jobs[0].CollectionID, jobs[1].CollectionID)
	// Both graphs contain a profile; only the graph root determines the filter.
	for i, kind := range []string{"x.post", "x.profile"} {
		_, e = admin.Pool.Exec(ctx, `UPDATE revisions SET payload=payload || jsonb_build_object('graph', jsonb_build_object('root','root','entities',jsonb_build_array(jsonb_build_object('key','root','type',$2::text),jsonb_build_object('key','author','type','x.profile')))) WHERE collection_id=$1`, jobs[i].CollectionID, kind)
		must(t, e)
		// Build the relational graph too, as finalization does in production.
		must(t, db.Tx(ctx, a.TenantID, func(tx pgx.Tx) error {
			var raw []byte
			var rid, cid string
			if err := tx.QueryRow(ctx, `SELECT id,capture_id,payload FROM revisions WHERE collection_id=$1`, jobs[i].CollectionID).Scan(&rid, &cid, &raw); err != nil {
				return err
			}
			var payload Payload
			if err := json.Unmarshal(raw, &payload); err != nil {
				return err
			}
			for j := range payload.Graph.Entities {
				entity := &payload.Graph.Entities[j]
				entity.ExternalID = jobs[i].CollectionID + entity.Key
				if i == 0 && entity.Key == "author" {
					entity.ExternalID = jobs[1].CollectionID + "root"
				}
				entity.Data = json.RawMessage(`{}`)
				entity.Schema = json.RawMessage(`{}`)
			}
			if i == 0 {
				payload.Graph.Relations = []domain.EntityRelation{{Source: "root", Target: "author", Type: "authored_by"}}
			}
			if err := persistEntities(ctx, tx, a.TenantID, cid, &payload, nil); err != nil {
				return err
			}
			if err := linkEntities(ctx, tx, a.TenantID, cid, rid, payload.Graph); err != nil {
				return err
			}
			raw, err := json.Marshal(payload)
			if err != nil {
				return err
			}
			_, err = tx.Exec(ctx, `UPDATE revisions SET payload=$2 WHERE id=$1`, rid, raw)
			return err
		}))
	}
	for _, kind := range []string{"x.post", "x.profile", "x.post,x.profile"} {
		filtered, err := s.Collections(ctx, a.TenantID, CollectionFilter{EntityType: kind}, "")
		must(t, err)
		want := len(strings.Split(kind, ","))
		if len(filtered.Items) != want {
			t.Fatalf("%s: got %d items", kind, len(filtered.Items))
		}
	}
	// A profile's related posts use stored entity identity and tenant ownership.
	related, err := s.Collections(ctx, a.TenantID, CollectionFilter{RelatedTo: jobs[1].CollectionID, EntityType: "x.post"}, "")
	must(t, err)
	if len(related.Items) != 1 || related.Items[0].ID != jobs[0].CollectionID || related.TotalStorageBytes == nil || *related.TotalStorageBytes != related.Items[0].StorageBytes {
		t.Fatalf("related collection or storage mismatch: %+v", related)
	}
	otherRelated, err := s.Collections(ctx, b.TenantID, CollectionFilter{RelatedTo: jobs[1].CollectionID, EntityType: "x.post"}, "")
	must(t, err)
	if len(otherRelated.Items) != 0 || otherRelated.TotalStorageBytes == nil || *otherRelated.TotalStorageBytes != 0 {
		t.Fatalf("related collections leaked across tenants: %+v", otherRelated)
	}
	if _, err := s.Collections(ctx, a.TenantID, CollectionFilter{RelatedTo: "not-a-uuid"}, ""); !errors.Is(err, ErrInvalidFilter) {
		t.Fatal(err)
	}
	if _, err := s.Collections(ctx, a.TenantID, CollectionFilter{EntityType: "invalid type"}, ""); !errors.Is(err, ErrInvalidFilter) {
		t.Fatal(err)
	}

	// Authors are the adapter's own graph identities. Nine captures of author-1
	// carry an old display name and the newest carries the current one; author-2
	// and author-3 are different accounts that happen to share a display name;
	// the last collection has no authored_by relation at all.
	setAuthor := func(job domain.Job, external, name string, at time.Time) {
		_, e := admin.Pool.Exec(ctx, `UPDATE revisions SET created_at=$4::timestamptz,payload=payload||jsonb_build_object('author_name',$2::text,'graph',jsonb_build_object('root','post','relations',jsonb_build_array(jsonb_build_object('source','post','target','author','type','authored_by')),'entities',jsonb_build_array(jsonb_build_object('key','post','type','x.post','external_id','post'),jsonb_build_object('key','author','type','x.profile','external_id',$3::text)))) WHERE id=(SELECT current_revision FROM collections WHERE id=$1)`, job.CollectionID, name, external, at)
		must(t, e)
	}
	base := time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC)
	for i, job := range jobs[:21] {
		switch {
		case i < 10:
			name := "旧名"
			if i == 9 {
				name = "新名"
			}
			setAuthor(job, "author-1", name, base.Add(time.Duration(i)*time.Hour))
		case i < 20:
			setAuthor(job, "author-2", "同名作者", base.Add(time.Duration(i)*time.Hour))
		default:
			setAuthor(job, "author-3", "同名作者", base.Add(time.Duration(i)*time.Hour))
		}
	}
	authorOne, authorTwo, authorThree := "x/x.profile/author-1", "x/x.profile/author-2", "x/x.profile/author-3"
	authors, err := s.CollectionAuthors(ctx, a.TenantID)
	must(t, err)
	// A renamed account stays one option under its latest captured name, two
	// accounts sharing a name stay apart, and an unauthored collection adds none.
	// Ordered by display name, then by identity so same-named accounts are stable.
	want := []CollectionAuthor{{ID: authorTwo, Name: "同名作者"}, {ID: authorThree, Name: "同名作者"}, {ID: authorOne, Name: "新名"}}
	if !reflect.DeepEqual(authors, want) {
		t.Fatalf("author choices: %v", authors)
	}
	for key, count := range map[string]int{authorOne: 10, authorTwo: 10, authorThree: 1} {
		matched, err := s.Collections(ctx, a.TenantID, CollectionFilter{Authors: []string{key}}, "")
		must(t, err)
		if len(matched.Items) != count {
			t.Fatalf("author %s matched %d", key, len(matched.Items))
		}
	}
	// Selecting one of two same-named accounts must not drag in the other.
	sameName, err := s.Collections(ctx, a.TenantID, CollectionFilter{Authors: []string{authorTwo, authorThree}}, "")
	must(t, err)
	if len(sameName.Items) != 11 {
		t.Fatalf("same-name authors merged or split: %d", len(sameName.Items))
	}
	union := []string{authorOne, authorTwo, authorThree}
	unionPage, err := s.Collections(ctx, a.TenantID, CollectionFilter{Authors: union}, "")
	must(t, err)
	if len(unionPage.Items) != 20 || unionPage.Next == "" {
		t.Fatal("author union failed")
	}
	unionTail, err := s.Collections(ctx, a.TenantID, CollectionFilter{Authors: union}, unionPage.Next)
	must(t, err)
	if len(unionTail.Items) != 1 || unionTail.Next != "" {
		t.Fatal("author pagination failed")
	}
	if _, err = s.Collections(ctx, a.TenantID, CollectionFilter{Authors: []string{authorOne}}, unionPage.Next); err == nil {
		t.Fatal("cursor accepted changed authors")
	}
	for _, invalid := range []string{"新名", "x/x.profile", "x/x.profile/author-1/extra", "x//author-1", "x/x.profile/author%2d1"} {
		if _, err = s.Collections(ctx, a.TenantID, CollectionFilter{Authors: []string{invalid}}, ""); !errors.Is(err, ErrInvalidFilter) {
			t.Fatalf("accepted author key %q", invalid)
		}
	}
	// Another tenant only ever sees authors of what it saved itself.
	shared := jobs[20].CollectionID
	added, err := s.SavePublicCollection(ctx, b.TenantID, shared)
	must(t, err)
	if !added {
		t.Fatal("shared reference missing")
	}
	foreign, err := s.CollectionAuthors(ctx, b.TenantID)
	must(t, err)
	if !reflect.DeepEqual(foreign, []CollectionAuthor{{ID: authorThree, Name: "同名作者"}}) {
		t.Fatalf("foreign authors exposed: %v", foreign)
	}
	leak, err := s.Collections(ctx, b.TenantID, CollectionFilter{Authors: []string{authorOne}}, "")
	must(t, err)
	if len(leak.Items) != 0 {
		t.Fatal("author filter crossed tenants")
	}
	must(t, s.DeleteCollection(ctx, b.TenantID, shared))
	// Storage order must remain stable across pages, including equal-sized items.
	for i, job := range jobs {
		_, e = admin.Pool.Exec(ctx, `UPDATE revisions SET content_bytes=$2 WHERE collection_id=$1`, job.CollectionID, (i/2)*100)
		must(t, e)
	}
	for _, order := range []string{"asc", "desc"} {
		filter := CollectionFilter{Sort: "storage", Order: order, Media: "image,text"}
		first, err := s.Collections(ctx, a.TenantID, filter, "")
		must(t, err)
		if len(first.Items) != 20 || first.Next == "" {
			t.Fatal(first)
		}
		second, err := s.Collections(ctx, a.TenantID, filter, first.Next)
		must(t, err)
		all := append(first.Items, second.Items...)
		if len(all) != 22 || second.Next != "" {
			t.Fatalf("storage pagination: %d", len(all))
		}
		seen := map[string]bool{}
		for i, item := range all {
			if seen[item.ID] {
				t.Fatal("duplicate storage result")
			}
			seen[item.ID] = true
			if i > 0 {
				previous := all[i-1]
				less := previous.StorageBytes < item.StorageBytes || (previous.StorageBytes == item.StorageBytes && previous.ID < item.ID)
				if (order == "asc") != less {
					t.Fatal("incorrect storage ordering")
				}
			}
			detail, err := s.SavedCollection(ctx, a.TenantID, item.ID)
			must(t, err)
			if detail.StorageBytes != item.StorageBytes {
				t.Fatal("detail storage differs")
			}
		}
		if _, err = s.Collections(ctx, a.TenantID, CollectionFilter{Sort: "captured"}, first.Next); err == nil {
			t.Fatal("storage cursor accepted for another sort")
		}
	}
	if _, err := s.Collections(ctx, a.TenantID, CollectionFilter{Media: "image,invalid"}, ""); !errors.Is(err, ErrInvalidFilter) {
		t.Fatal("invalid media accepted")
	}
	page, e := s.Collections(ctx, a.TenantID, CollectionFilter{Q: "中文", Media: "text", Visibility: "public"}, "")
	must(t, e)
	if len(page.Items) != 20 || page.Next == "" {
		t.Fatal(page)
	}
	must(t, s.DeleteCollection(ctx, a.TenantID, page.Items[19].ID))
	tail, e := s.Collections(ctx, a.TenantID, CollectionFilter{Q: "中文", Media: "text", Visibility: "public"}, page.Next)
	must(t, e)
	if len(tail.Items) != 2 {
		t.Fatal(tail)
	}
	if _, e = s.Collections(ctx, a.TenantID, CollectionFilter{Q: "changed"}, page.Next); e == nil {
		t.Fatal("foreign query cursor")
	}
	empty, e := s.Collections(ctx, b.TenantID, CollectionFilter{}, "")
	must(t, e)
	if len(empty.Items) != 0 {
		t.Fatal("foreign saves exposed")
	}
	literal, e := s.Collections(ctx, a.TenantID, CollectionFilter{Q: "100%"}, "")
	must(t, e)
	if len(literal.Items) == 0 {
		t.Fatal("literal wildcard search failed")
	}
	empty, e = s.Collections(ctx, a.TenantID, CollectionFilter{From: time.Now().Add(time.Hour).Format(time.RFC3339)}, "")
	must(t, e)
	if len(empty.Items) != 0 {
		t.Fatal("date ignored")
	}
	// Published order reverses capture order; ties use IDs and invalid dates fall back.
	for i, job := range jobs {
		_, e = admin.Pool.Exec(ctx, `UPDATE revisions SET payload=jsonb_set(payload,'{published_at}',to_jsonb($2::text)) WHERE id=(SELECT current_revision FROM collections WHERE id=$1)`, job.CollectionID, time.Date(2026, 1, 22-i, 0, 0, 0, 0, time.UTC).Format(time.RFC3339))
		must(t, e)
	}
	published, e := s.Collections(ctx, a.TenantID, CollectionFilter{Sort: "published"}, "")
	must(t, e)
	if len(published.Items) != 20 || published.Next == "" || published.Items[0].ID != jobs[0].CollectionID {
		t.Fatal(published)
	}
	publishedTail, e := s.Collections(ctx, a.TenantID, CollectionFilter{Sort: "published"}, published.Next)
	must(t, e)
	if len(publishedTail.Items) != 1 || publishedTail.Next != "" {
		t.Fatal(publishedTail)
	}
	ascending, e := s.Collections(ctx, a.TenantID, CollectionFilter{Sort: "published", Order: "asc"}, "")
	must(t, e)
	if len(ascending.Items) != 20 || ascending.Items[0].ID != jobs[21].CollectionID {
		t.Fatal(ascending)
	}
	ascendingTail, e := s.Collections(ctx, a.TenantID, CollectionFilter{Sort: "published", Order: "asc"}, ascending.Next)
	must(t, e)
	if len(ascendingTail.Items) != 1 || ascendingTail.Items[0].ID != jobs[0].CollectionID || ascendingTail.Next != "" {
		t.Fatal(ascendingTail)
	}
	if _, e = s.Collections(ctx, a.TenantID, CollectionFilter{Sort: "published", Order: "asc"}, published.Next); e == nil {
		t.Fatal("cursor accepted for a different direction")
	}
	if _, e = s.Collections(ctx, a.TenantID, CollectionFilter{Sort: "captured"}, published.Next); e == nil {
		t.Fatal("cursor accepted for a different sort")
	}
	if _, e = s.Collections(ctx, a.TenantID, CollectionFilter{Sort: "invalid"}, ""); !errors.Is(e, ErrInvalidFilter) {
		t.Fatal("invalid sort accepted")
	}
	_, e = admin.Pool.Exec(ctx, `UPDATE revisions SET payload=jsonb_set(payload,'{published_at}','"invalid"'::jsonb) WHERE id=(SELECT current_revision FROM collections WHERE id=$1)`, jobs[0].CollectionID)
	must(t, e)
	fallback, e := s.Collections(ctx, a.TenantID, CollectionFilter{Sort: "published"}, "")
	must(t, e)
	if fallback.Items[0].ID != jobs[0].CollectionID {
		t.Fatal("invalid publication date did not fall back to capture time")
	}
	id := jobs[0].CollectionID
	// Use a retained item in case the pagination anchor happened to be this collection.
	id = page.Items[0].ID
	if !errors.Is(s.WebAccess(ctx, b.TenantID, "collections", id), domain.ErrNotFound) {
		t.Fatal("public non-save exposed")
	}
	versions, e := s.Revisions(ctx, a.TenantID, id, "")
	must(t, e)
	if len(versions.Items) != 1 {
		t.Fatal(versions)
	}
	snapshot, e := s.Revision(ctx, a.TenantID, id, versions.Items[0].ID)
	must(t, e)
	if snapshot.Text != "中文收藏 100%" {
		t.Fatal(snapshot)
	}
	if _, e = s.Revision(ctx, b.TenantID, id, versions.Items[0].ID); !errors.Is(e, domain.ErrNotFound) {
		t.Fatal(e)
	}
	fake.set("新版本")
	job, e := s.Submit(ctx, a.TenantID, domain.CaptureInput{RefreshID: id})
	must(t, e)
	must(t, s.capture(ctx, store.Task{Tenant: a.TenantID, ID: job.ID}))
	must(t, s.finalize(ctx, a.TenantID, job.ID))
	snapshot, e = s.Revision(ctx, a.TenantID, id, versions.Items[0].ID)
	must(t, e)
	if snapshot.Text != "中文收藏 100%" {
		t.Fatal("history overwritten")
	}
	must(t, s.DeleteCollection(ctx, a.TenantID, id))
	if _, e = s.Revision(ctx, a.TenantID, id, versions.Items[0].ID); !errors.Is(e, domain.ErrNotFound) {
		t.Fatal(e)
	}

	// Sensitivity is decided by the current revision's content resources: an
	// avatar never marks a collection sensitive, and a collection with no
	// resources at all counts as not containing any.
	var marked []domain.Job
	for range 2 {
		j, err := s.Submit(ctx, a.TenantID, domain.CaptureInput{URL: fmt.Sprintf("https://x.com/a/status/%d", time.Now().UnixNano())})
		must(t, err)
		must(t, s.capture(ctx, store.Task{Tenant: a.TenantID, ID: j.ID}))
		must(t, s.finalize(ctx, a.TenantID, j.ID))
		marked = append(marked, j)
	}
	author := "x/x.profile/author-sensitive"
	for i, job := range marked {
		setAuthor(job, "author-sensitive", "敏感作者", base.Add(time.Duration(i)*time.Hour))
		purpose := ""
		if i == 1 {
			purpose = "avatar"
		}
		_, e = admin.Pool.Exec(ctx, `INSERT INTO assets(tenant_id,visibility,capture_id,position,source_url,purpose,kind,state,sensitive) SELECT $1,rv.visibility,rv.capture_id,99,'https://example.test/sensitive.png',$3,'image','ready',TRUE FROM revisions rv JOIN collections c ON c.current_revision=rv.id WHERE c.id=$2`, a.TenantID, job.CollectionID, purpose)
		must(t, e)
	}
	for value, want := range map[string]string{"contains": marked[0].CollectionID, "not_contains": marked[1].CollectionID} {
		page, err := s.Collections(ctx, a.TenantID, CollectionFilter{Authors: []string{author}, Sensitive: value}, "")
		must(t, err)
		if len(page.Items) != 1 || page.Items[0].ID != want {
			t.Fatalf("sensitive %s: %v", value, page.Items)
		}
	}
	all, e := s.Collections(ctx, a.TenantID, CollectionFilter{Authors: []string{author}}, "")
	must(t, e)
	if len(all.Items) != 2 {
		t.Fatal("empty sensitive filter narrowed results")
	}
	if _, e = s.Collections(ctx, a.TenantID, CollectionFilter{Sensitive: "maybe"}, ""); !errors.Is(e, ErrInvalidFilter) {
		t.Fatal("invalid sensitive filter accepted")
	}
	bound, e := s.Collections(ctx, a.TenantID, CollectionFilter{Sensitive: "not_contains"}, "")
	must(t, e)
	if bound.Next == "" {
		t.Fatal("sensitive filter lost pagination")
	}
	if _, e = s.Collections(ctx, a.TenantID, CollectionFilter{Sensitive: "contains"}, bound.Next); e == nil {
		t.Fatal("cursor accepted a changed sensitive filter")
	}
}

type registryFixture struct {
	*fakeAdapter
	mu      sync.Mutex
	offline bool
}

func (f *registryFixture) Describe(ctx context.Context, r *pb.DescribeRequest, o ...grpc.CallOption) (*pb.DescribeResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.offline {
		return nil, status.Error(codes.Unavailable, "offline")
	}
	return f.fakeAdapter.Describe(ctx, r, o...)
}

func TestAdapterRegistryRecovery(t *testing.T) {
	ctx := context.Background()
	f := &registryFixture{fakeAdapter: &fakeAdapter{}, offline: true}
	r := NewAdapterRegistry([]AdapterEndpoint{{Client: f}})
	s := &Service{Registry: r}
	must(t, r.Refresh(ctx))
	if _, e := s.forAdapter("fixture"); !errors.Is(e, ErrAdapterUnavailable) {
		t.Fatal(e)
	}
	f.offline = false
	must(t, r.Refresh(ctx))
	if _, e := s.forAdapter("fixture"); e != nil {
		t.Fatal(e)
	}
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for range 1000 {
			_ = s.adapterBindings()
			_, _ = s.forAdapter("fixture")
		}
	}()
	f.mu.Lock()
	f.offline = true
	f.mu.Unlock()
	must(t, r.Refresh(ctx))
	wg.Wait()
	if len(r.snapshot()) != 1 {
		t.Fatal("lost descriptor for saved source")
	}
	if r.available["fixture"] {
		t.Fatal("offline adapter marked available")
	}
}
