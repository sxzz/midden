//go:build perf

package app

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"google.golang.org/grpc"

	pb "monitor/api/adapter/v1"
	"monitor/internal/domain"
	"monitor/internal/store"
)

// The performance suite runs against a database chosen by scripts/perf.sh,
// never the integration database: seeding writes a library through the real
// capture path, benchmarking times every read API over it, and dumping records
// what each tenant is shown so two builds can be compared byte for byte.
//
//	PERF_DATABASE_URL        application role
//	PERF_ADMIN_DATABASE_URL  owner role, for fixtures and catalog reads
//	PERF_TENANT              limit a run to one tenant (default: all with saves)

type perfEnv struct {
	ctx     context.Context
	admin   *store.Store
	db      *store.Store
	service *Service
	tenants []string
	tracer  *perfTracer
}

// perfTracer keeps the statements of one call so they can be explained.
type perfTracer struct {
	mu      sync.Mutex
	capture bool
	got     []perfStatement
}

type perfStatement struct {
	sql  string
	args []any
}

func (p *perfTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, d pgx.TraceQueryStartData) context.Context {
	p.mu.Lock()
	defer p.mu.Unlock()
	// Transaction control and the tenant setting are not worth a plan.
	switch first, _, _ := strings.Cut(strings.ToLower(strings.TrimSpace(d.SQL)), " "); {
	case !p.capture, first == "begin", first == "commit", first == "rollback", strings.HasPrefix(d.SQL, "SELECT set_config"):
	default:
		p.got = append(p.got, perfStatement{d.SQL, d.Args})
	}
	return ctx
}
func (p *perfTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func openPerf(t *testing.T) *perfEnv {
	t.Helper()
	if os.Getenv("PERF_DATABASE_URL") == "" || os.Getenv("PERF_ADMIN_DATABASE_URL") == "" {
		t.Skip("run through scripts/perf.sh")
	}
	ctx := context.Background()
	admin, err := store.Open(ctx, os.Getenv("PERF_ADMIN_DATABASE_URL"))
	must(t, err)
	t.Cleanup(admin.Close)
	cfg, err := pgxpool.ParseConfig(os.Getenv("PERF_DATABASE_URL"))
	must(t, err)
	tracer := &perfTracer{}
	cfg.ConnConfig.Tracer = tracer
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	must(t, err)
	t.Cleanup(pool.Close)
	env := &perfEnv{ctx: ctx, admin: admin, db: &store.Store{Pool: pool}, tracer: tracer}
	env.service = &Service{DB: env.db, Config: Defaults()}
	if one := os.Getenv("PERF_TENANT"); one != "" {
		env.tenants = []string{one}
	} else {
		env.tenants = env.list(`SELECT tenant_id::text FROM tenant_collections GROUP BY tenant_id ORDER BY count(*) DESC,tenant_id`)
	}
	return env
}

func (e *perfEnv) list(query string, args ...any) []string {
	rows, err := e.admin.Pool.Query(e.ctx, query, args...)
	if err != nil {
		panic(err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var v string
		if err = rows.Scan(&v); err != nil {
			panic(err)
		}
		out = append(out, v)
	}
	if err = rows.Err(); err != nil {
		panic(err)
	}
	return out
}

func perfInt(name string, fallback int) int {
	if v, err := strconv.Atoi(os.Getenv(name)); err == nil {
		return v
	}
	return fallback
}

// perfAdapter answers for a synthetic platform whose content follows from the
// requested id alone, so a library of any size can be captured without fixtures.
//
//	/a<author>/status/<n>   a post by that author; every fifth quotes post n-1
//	/a<author>/profile      the author's profile
//
// The "sealed" provider returns the same content as private to its tenant;
// the seed uses it for every tenth post.
type perfAdapter struct {
	*fakeAdapter
	mu       sync.Mutex
	revision map[string]int
}

var perfURL = regexp.MustCompile(`^/a([0-9]+)/(?:status/([0-9]+)|profile)$`)

func (*perfAdapter) Describe(context.Context, *pb.DescribeRequest, ...grpc.CallOption) (*pb.DescribeResponse, error) {
	schema := []byte(`{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}`)
	types := []*pb.EntityType{{Name: "x.post", JsonSchema: schema}, {Name: "x.profile", JsonSchema: schema}}
	capabilities := []*pb.Capability{{Name: "capture.fetch", Major: 1}, {Name: "entity.graph", Major: 1}}
	provider := func(id string, visibility pb.Visibility) *pb.Provider {
		return &pb.Provider{Id: id, DefaultProvider: id == "open", Authentication: "none", Visibilities: []pb.Visibility{visibility}, EntityTypes: []string{"x.post", "x.profile"}, Capabilities: capabilities}
	}
	return &pb.DescribeResponse{EntityTypes: types, ProtocolVersion: "1.0", AdapterId: "fixture", Providers: []*pb.Provider{
		provider("open", pb.Visibility_VISIBILITY_PUBLIC), provider("sealed", pb.Visibility_VISIBILITY_PRIVATE),
	}}, nil
}

func (*perfAdapter) Resolve(_ context.Context, r *pb.ResolveRequest, _ ...grpc.CallOption) (*pb.ResolveResponse, error) {
	m := perfURL.FindStringSubmatch(strings.TrimPrefix(r.Url, "https://x.com"))
	if m == nil {
		return nil, fmt.Errorf("unsupported perf URL %s", r.Url)
	}
	if m[2] == "" {
		return &pb.ResolveResponse{Url: r.Url, ExternalId: "a" + m[1], Platform: "x", Kind: "profile"}, nil
	}
	return &pb.ResolveResponse{Url: r.Url, ExternalId: m[1] + "-" + m[2], Platform: "x", Kind: "post"}, nil
}

func perfProfile(key, author string) *pb.Entity {
	return &pb.Entity{Key: key, Type: "x.profile", ExternalId: "a" + author, DataJson: []byte(fmt.Sprintf(`{"name":"Author %s","username":"author%s"}`, author, author))}
}

func (a *perfAdapter) Fetch(_ context.Context, r *pb.FetchRequest, _ ...grpc.CallOption) (*pb.FetchResponse, error) {
	a.mu.Lock()
	revision := a.revision[r.ExternalId]
	a.mu.Unlock()
	out := &pb.FetchResponse{ExternalId: r.ExternalId, ProviderId: r.ProviderId, Visibility: pb.Visibility_VISIBILITY_PUBLIC, AdapterVersion: "perf", TextKind: "plain"}
	if r.ProviderId == "sealed" {
		out.Visibility = pb.Visibility_VISIBILITY_PRIVATE
	}
	if author, ok := strings.CutPrefix(r.ExternalId, "a"); ok {
		out.AuthorName, out.Text, out.Summary = "Author "+author, fmt.Sprintf("profile of author %s, seen %d times", author, revision), "Author "+author
		out.Graph = &pb.EntityGraph{Root: "profile", Entities: []*pb.Entity{perfProfile("profile", author)}}
		return out, nil
	}
	author, number, _ := strings.Cut(r.ExternalId, "-")
	n, _ := strconv.Atoi(number)
	published := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC).Add(time.Duration(n) * time.Minute).Format(time.RFC3339)
	out.AuthorName, out.PublishedAt = "Author "+author, published
	out.Text = fmt.Sprintf("post %d by author %s about topic%d, edit %d", n, author, n%97, revision)
	out.Summary = out.AuthorName + ": " + out.Text
	post := &pb.Entity{Key: "post", Type: "x.post", ExternalId: r.ExternalId, DataJson: []byte(fmt.Sprintf(`{"text":%q,"published_at":%q,"likes":%d}`, out.Text, published, n%1000+revision))}
	out.Graph = &pb.EntityGraph{Root: "post", Entities: []*pb.Entity{post, perfProfile("author", author)}, Relations: []*pb.EntityRelation{{Source: "post", Target: "author", Type: authorRelation}}}
	if n%5 == 0 && n > 0 {
		quoted := fmt.Sprintf("%s-%d", author, n-1)
		out.Graph.Entities = append(out.Graph.Entities, &pb.Entity{Key: "quoted", Type: "x.post", ExternalId: quoted, ContextOnly: true, DataJson: []byte(fmt.Sprintf(`{"text":"post %d"}`, n-1))})
		out.Graph.Relations = append(out.Graph.Relations, &pb.EntityRelation{Source: "post", Target: "quoted", Type: "quoted"}, &pb.EntityRelation{Source: "quoted", Target: "author", Type: authorRelation})
	}
	return out, nil
}

// TestPerfSeed captures a library for several tenants through Submit, capture
// and finalize. Tenants draw from the same authors, so part of the content is
// shared between them; a tenth of it is captured twice with changed content.
//
//	PERF_SEED_TENANTS      tenants to create (default 4)
//	PERF_SEED_COLLECTIONS  posts saved per tenant (default 2000)
//	PERF_SEED_AUTHORS      authors the posts are spread over (default collections/40)
func TestPerfSeed(t *testing.T) {
	env := openPerf(t)
	ctx := env.ctx
	tenants, posts := perfInt("PERF_SEED_TENANTS", 4), perfInt("PERF_SEED_COLLECTIONS", 2000)
	authors := perfInt("PERF_SEED_AUTHORS", max(posts/40, 1))
	queue, err := river.NewClient(riverpgxv5.New(env.db.Pool), &river.Config{})
	must(t, err)
	adapter := &perfAdapter{fakeAdapter: &fakeAdapter{}, revision: map[string]int{}}
	config := Defaults()
	config.Rate = 1 << 30
	s := &Service{DB: env.db, Queue: queue, Adapter: adapter, Config: config, Blobs: &memoryBlob{m: map[string][]byte{}}}
	start := time.Now()
	var wg sync.WaitGroup
	failures := make(chan error, tenants)
	for i := range tenants {
		var tenant string
		must(t, env.admin.Pool.QueryRow(ctx, `INSERT INTO tenants(quota_bytes) VALUES(1::bigint<<50) RETURNING id`).Scan(&tenant))
		wg.Go(func() {
			run := func(in domain.CaptureInput) (string, error) {
				j, err := s.Submit(ctx, tenant, in)
				if err != nil || j.State != "queued" {
					// Content another tenant already captured is saved as it is.
					return j.CollectionID, err
				}
				if err = s.capture(ctx, store.Task{Tenant: tenant, ID: j.ID, Type: "capture"}); err != nil {
					return "", err
				}
				return j.CollectionID, s.finalize(ctx, tenant, j.ID)
			}
			for n := range posts {
				// Neighbouring tenants overlap on half of their posts.
				number := n + i*posts/2
				author := number % authors
				external := fmt.Sprintf("%d-%d", author, number)
				url := fmt.Sprintf("https://x.com/a%d/status/%d", author, number)
				provider := ""
				if number%10 == 0 {
					provider = "sealed"
				}
				collection, err := run(domain.CaptureInput{URL: url, ProviderID: provider})
				if err != nil {
					failures <- fmt.Errorf("%s: %w", url, err)
					return
				}
				if n%10 == 3 {
					adapter.mu.Lock()
					adapter.revision[external]++
					adapter.mu.Unlock()
					if _, err := run(domain.CaptureInput{RefreshID: collection}); err != nil {
						failures <- fmt.Errorf("%s again: %w", url, err)
						return
					}
				}
				if n < authors && n%4 == 0 {
					if _, err := run(domain.CaptureInput{URL: fmt.Sprintf("https://x.com/a%d/profile", author)}); err != nil {
						failures <- fmt.Errorf("profile %d: %w", author, err)
						return
					}
				}
			}
		})
	}
	wg.Wait()
	close(failures)
	for err := range failures {
		t.Error(err)
	}
	// Nothing works the queue here; the jobs would only be reported as stale.
	_, err = env.admin.Pool.Exec(ctx, `DELETE FROM river_job WHERE kind='monitor_task'`)
	must(t, err)
	_, err = env.admin.Pool.Exec(ctx, `ANALYZE`)
	must(t, err)
	var saved, collections, revisions int
	must(t, env.admin.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM tenant_collections),(SELECT count(*) FROM collections),(SELECT count(*) FROM revisions)`).Scan(&saved, &collections, &revisions))
	fmt.Printf("seeded %d tenants in %s: %d saves, %d collections, %d revisions\n", tenants, time.Since(start).Round(time.Second), saved, collections, revisions)
}

type perfSample struct {
	name, detail string
	took         time.Duration
}

// perfCalls visits every read API for one tenant. Each visit reports what it
// returned, so the same walk serves timing and comparison.
func (e *perfEnv) perfCalls(tenant string, limit int, visit func(name, detail string, call func() (any, error))) {
	s, ctx := e.service, e.ctx
	visit("Usage", "", func() (any, error) { return s.Usage(ctx, tenant) })
	visit("Tags", "", func() (any, error) { return s.Tags(ctx, tenant) })
	var authors []CollectionAuthor
	visit("CollectionAuthors", "", func() (any, error) {
		var err error
		authors, err = s.CollectionAuthors(ctx, tenant)
		return authors, err
	})
	cursor := ""
	for page := 0; page < limit; page++ {
		var next string
		visit("Recent", fmt.Sprint("page ", page), func() (any, error) {
			p, err := s.Recent(ctx, tenant, cursor)
			next = p.NextCursor
			return p, err
		})
		if cursor = next; cursor == "" {
			break
		}
	}
	filters := []struct {
		name   string
		filter CollectionFilter
	}{
		{"none", CollectionFilter{}},
		{"sort=published", CollectionFilter{Sort: "published"}},
		{"sort=published asc", CollectionFilter{Sort: "published", Order: "asc"}},
		{"sort=storage", CollectionFilter{Sort: "storage"}},
		{"q=topic7", CollectionFilter{Q: "topic7"}},
		{"q=absent", CollectionFilter{Q: "zzzzqqq"}},
		{"media=image", CollectionFilter{Media: "image"}},
		{"media=text", CollectionFilter{Media: "text"}},
		{"visibility=public", CollectionFilter{Visibility: "public"}},
		{"visibility=private", CollectionFilter{Visibility: "private"}},
		{"sensitive=not_contains", CollectionFilter{Sensitive: "not_contains"}},
		{"type=x.post", CollectionFilter{EntityType: "x.post"}},
		{"type=x.profile", CollectionFilter{EntityType: "x.profile"}},
		// A fixed bound: the filter is part of the cursor, and dumps must repeat.
		{"saved since 2026", CollectionFilter{From: "2026-01-01T00:00:00Z"}},
	}
	for i, a := range authors {
		if i >= 3 {
			break
		}
		filters = append(filters, struct {
			name   string
			filter CollectionFilter
		}{fmt.Sprint("author#", i), CollectionFilter{Authors: []string{a.ID}}})
	}
	for _, f := range filters {
		cursor := ""
		for page := 0; page < limit; page++ {
			var next string
			visit("Collections["+f.name+"]", fmt.Sprint("page ", page), func() (any, error) {
				p, err := s.Collections(ctx, tenant, f.filter, cursor)
				next = p.Next
				return p, err
			})
			if cursor = next; cursor == "" {
				break
			}
		}
	}
	for _, id := range e.list(`SELECT c.id::text FROM tenant_collections tc JOIN collections c ON c.id=tc.collection_id WHERE tc.tenant_id=$1 AND c.kind='profile' ORDER BY c.id LIMIT $2`, tenant, limit*5) {
		for _, f := range []CollectionFilter{{RelatedTo: id}, {RelatedTo: id, EntityType: "x.post", Sort: "published"}} {
			visit("Collections[related_to,type="+f.EntityType+"]", id, func() (any, error) { return s.Collections(ctx, tenant, f, "") })
		}
	}
	saved := e.list(`SELECT collection_id::text FROM tenant_collections WHERE tenant_id=$1 ORDER BY created_at DESC,collection_id LIMIT $2`, tenant, limit*20)
	for _, id := range saved {
		visit("WebAccess[collections]", id, func() (any, error) { return nil, s.WebAccess(ctx, tenant, "collections", id) })
		visit("SavedCollection", id, func() (any, error) { return s.SavedCollection(ctx, tenant, id) })
		visit("Collection", id, func() (any, error) { return s.Collection(ctx, tenant, id) })
		visit("Revisions", id, func() (any, error) { return s.Revisions(ctx, tenant, id, "") })
		visit("Sources", id, func() (any, error) { return s.Sources(ctx, tenant, id) })
		visit("Annotation", id, func() (any, error) { return s.Annotation(ctx, tenant, id) })
	}
	// What a tenant has not saved is part of the picture too: reads of
	// another tenant's content must keep failing the same way.
	for _, id := range e.list(`SELECT c.id::text FROM collections c WHERE NOT EXISTS(SELECT FROM tenant_collections tc WHERE tc.collection_id=c.id AND tc.tenant_id=$1) ORDER BY c.id LIMIT $2`, tenant, limit*5) {
		visit("Collection[unsaved]", id, func() (any, error) { return s.Collection(ctx, tenant, id) })
		visit("WebAccess[unsaved]", id, func() (any, error) { return nil, s.WebAccess(ctx, tenant, "collections", id) })
	}
	rows, err := e.admin.Pool.Query(ctx, `SELECT r.collection_id::text,r.id::text FROM revisions r JOIN tenant_collections tc ON tc.collection_id=r.collection_id WHERE tc.tenant_id=$1 ORDER BY r.created_at DESC,r.id LIMIT $2`, tenant, limit*10)
	if err != nil {
		panic(err)
	}
	var revisions [][2]string
	for rows.Next() {
		var pair [2]string
		if err = rows.Scan(&pair[0], &pair[1]); err != nil {
			panic(err)
		}
		revisions = append(revisions, pair)
	}
	rows.Close()
	for _, pair := range revisions {
		visit("Revision", pair[0]+"/"+pair[1], func() (any, error) { return s.Revision(ctx, tenant, pair[0], pair[1]) })
	}
	for _, id := range e.list(`SELECT DISTINCT ev.entity_id::text FROM tenant_collections tc JOIN revisions r ON r.collection_id=tc.collection_id JOIN revision_entities re ON re.revision_id=r.id JOIN entity_versions ev ON ev.id=re.entity_version_id WHERE tc.tenant_id=$1 ORDER BY 1 LIMIT $2`, tenant, limit*10) {
		visit("WebAccess[entities]", id, func() (any, error) { return nil, s.WebAccess(ctx, tenant, "entities", id) })
		visit("Entity", id, func() (any, error) { return s.Entity(ctx, tenant, id) })
	}
	for _, id := range e.list(`SELECT m.id::text FROM tenant_collections tc JOIN revisions r ON r.collection_id=tc.collection_id JOIN assets m ON m.capture_id=r.capture_id WHERE tc.tenant_id=$1 AND m.state='ready' ORDER BY 1 LIMIT $2`, tenant, limit*10) {
		visit("WebAccess[assets]", id, func() (any, error) { return nil, s.WebAccess(ctx, tenant, "assets", id) })
		visit("Asset", id, func() (any, error) { return s.Asset(ctx, tenant, id) })
		visit("Thumbnail", id, func() (any, error) { return s.Thumbnail(ctx, tenant, id) })
	}
	for _, id := range e.list(`SELECT id::text FROM refresh_batches WHERE tenant_id=$1 ORDER BY id LIMIT $2`, tenant, limit) {
		visit("RefreshBatch", id, func() (any, error) { return s.RefreshBatch(ctx, tenant, id) })
	}
	for _, id := range e.list(`SELECT s.id::text FROM submissions s JOIN captures c ON c.id=s.capture_id WHERE s.tenant_id=$1 AND c.is_collection ORDER BY s.created_at DESC,s.id LIMIT $2`, tenant, limit*5) {
		visit("channelCollection", id, func() (any, error) { return s.channelCollection(ctx, tenant, id) })
	}
}

// TestPerfBench times every read API and prints the slowest first.
//
//	PERF_PAGES  pages walked per list and the base for per-item samples (default 20)
func TestPerfBench(t *testing.T) {
	env := openPerf(t)
	samples := map[string][]perfSample{}
	for _, tenant := range env.tenants {
		env.perfCalls(tenant, perfInt("PERF_PAGES", 20), func(name, detail string, call func() (any, error)) {
			start := time.Now()
			call()
			samples[name] = append(samples[name], perfSample{name, tenant[:8] + " " + detail, time.Since(start)})
		})
	}
	type row struct {
		name          string
		n             int
		p50, p95, max time.Duration
		slowest       string
	}
	var table []row
	for name, list := range samples {
		sort.Slice(list, func(i, j int) bool { return list[i].took < list[j].took })
		last := list[len(list)-1]
		table = append(table, row{name, len(list), list[(len(list)-1)/2].took, list[(len(list)-1)*95/100].took, last.took, last.detail})
	}
	sort.Slice(table, func(i, j int) bool { return table[i].p95 > table[j].p95 })
	round := func(d time.Duration) time.Duration { return d.Round(10 * time.Microsecond) }
	fmt.Printf("%-40s %6s %10s %10s %10s  %s\n", "call", "n", "p50", "p95", "max", "slowest input")
	for _, r := range table {
		fmt.Printf("%-40s %6d %10s %10s %10s  %s\n", r.name, r.n, round(r.p50), round(r.p95), round(r.max), r.slowest)
	}
}

// TestPerfDump writes what every tenant is shown, errors included, to PERF_OUT.
// Two dumps of the same database made by different builds must be identical.
func TestPerfDump(t *testing.T) {
	env := openPerf(t)
	out := map[string]any{}
	for _, tenant := range env.tenants {
		seen := map[string]int{}
		env.perfCalls(tenant, perfInt("PERF_PAGES", 20), func(name, detail string, call func() (any, error)) {
			key := tenant + "/" + name + "/" + detail
			seen[key]++
			key = fmt.Sprint(key, "#", seen[key])
			v, err := call()
			if err != nil {
				out[key] = "error: " + err.Error()
				return
			}
			out[key] = v
		})
	}
	body, err := json.MarshalIndent(out, "", " ")
	must(t, err)
	must(t, os.WriteFile(os.Getenv("PERF_OUT"), body, 0o644))
	fmt.Printf("wrote %d results for %d tenants\n", len(out), len(env.tenants))
}

// TestPerfExplain prints EXPLAIN (ANALYZE, BUFFERS) for each statement behind
// the slowest sample of the calls whose name contains PERF_CALL.
func TestPerfExplain(t *testing.T) {
	env := openPerf(t)
	want := os.Getenv("PERF_CALL")
	if want == "" {
		t.Fatal("PERF_CALL names the call to explain, for example Collections[none]")
	}
	tenant := env.tenants[0]
	var slowest time.Duration
	var statements []perfStatement
	env.perfCalls(tenant, perfInt("PERF_PAGES", 5), func(name, detail string, call func() (any, error)) {
		if !strings.Contains(name, want) {
			call()
			return
		}
		env.tracer.mu.Lock()
		env.tracer.capture, env.tracer.got = true, nil
		env.tracer.mu.Unlock()
		start := time.Now()
		call()
		took := time.Since(start)
		env.tracer.mu.Lock()
		env.tracer.capture = false
		if took > slowest {
			slowest, statements = took, env.tracer.got
			fmt.Printf("slowest so far: %s %s (%s)\n", name, detail, took.Round(10*time.Microsecond))
		}
		env.tracer.mu.Unlock()
	})
	for _, q := range statements {
		must(t, env.db.Tx(env.ctx, tenant, func(tx pgx.Tx) error {
			rows, err := tx.Query(env.ctx, "EXPLAIN (ANALYZE, BUFFERS) "+q.sql, q.args...)
			if err != nil {
				return err
			}
			defer rows.Close()
			fmt.Println("=====", strings.Join(strings.Fields(q.sql), " "))
			for rows.Next() {
				var line string
				if err = rows.Scan(&line); err != nil {
					return err
				}
				fmt.Println(line)
			}
			return rows.Err()
		}))
	}
}
