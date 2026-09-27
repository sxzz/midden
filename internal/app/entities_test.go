package app

import (
	"bytes"
	"context"
	"encoding/json"
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

func TestAccountRawCannotBecomePublic(t *testing.T) {
	r := &pb.FetchResponse{SourceResponses: []*pb.SourceResponse{{Body: []byte(`{"viewer":true}`), ContentType: "application/json", Visibility: pb.Visibility_VISIBILITY_PUBLIC}}}
	if _, e := sourceBytes(r, true); e == nil {
		t.Fatal("account response exposed as public")
	}
}

func TestAdapterDefinesEntityStructure(t *testing.T) {
	f := &fakeAdapter{graph: &pb.EntityGraph{Root: "report", Entities: []*pb.Entity{{Key: "report", Type: "weather.report", ExternalId: "station-1", DataJson: []byte(`{"temperature":24,"counter":9007199254740993}`)}}}, entityTypes: []*pb.EntityType{{Name: "weather.report", JsonSchema: []byte(`{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","required":["temperature"],"properties":{"temperature":{"type":"number"},"counter":{"type":"integer"}},"additionalProperties":false}`)}}}
	s := &Service{Adapter: f}
	r := &pb.FetchResponse{ProviderId: "fxtwitter", ExternalId: "station-1", Graph: f.graph}
	g, err := s.entityGraph(context.Background(), r)
	if err != nil || !bytes.Contains(g.Entities[0].Data, []byte("9007199254740993")) {
		t.Fatal("generic structure/precision lost", err)
	}
	r.Graph.Entities[0].DataJson = []byte(`{"temperature":"warm"}`)
	if _, err = s.entityGraph(context.Background(), r); err == nil {
		t.Fatal("adapter schema ignored")
	}
	r.Graph.Entities[0].DataJson = []byte(`{"temperature":24}`)
	r.Graph.Entities[0].ResourceIndices = []uint32{0}
	if _, err = s.entityGraph(context.Background(), r); err == nil {
		t.Fatal("invalid resource index accepted")
	}
	r.Graph.Entities[0].ResourceIndices = nil
	r.Graph.Relations = []*pb.EntityRelation{{Source: "report", Target: "missing", Type: "measured_by"}}
	if _, err = s.entityGraph(context.Background(), r); err == nil {
		t.Fatal("dangling relation accepted")
	}
	r.Graph.Relations = nil
	r.ProviderId = "unknown"
	if _, err = s.entityGraph(context.Background(), r); err == nil {
		t.Fatal("undeclared provider capability accepted")
	}
}

func TestMetadataRawIsolationAndRetention(t *testing.T) {
	if os.Getenv("TEST_DATABASE_URL") == "" {
		t.Skip("Docker required")
	}
	ctx := context.Background()
	admin, e := store.Open(ctx, os.Getenv("TEST_ADMIN_DATABASE_URL"))
	must(t, e)
	defer admin.Close()
	db, e := store.Open(ctx, os.Getenv("TEST_DATABASE_URL"))
	must(t, e)
	defer db.Close()
	tenants := make([]string, 3)
	for i := range tenants {
		must(t, admin.Pool.QueryRow(ctx, `INSERT INTO tenants DEFAULT VALUES RETURNING id`).Scan(&tenants[i]))
	}
	var portrait bytes.Buffer
	must(t, png.Encode(&portrait, image.NewRGBA(image.Rect(0, 0, 7, 11))))
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write(portrait.Bytes()) }))
	defer server.Close()
	raw := []byte("{ \"viewer\": true, \"extra\": [1,2] }\n")
	f := &fakeAdapter{public: true, text: "post", graph: &pb.EntityGraph{Root: "post", Entities: []*pb.Entity{{Key: "post", Type: "x.post", DataJson: []byte(`{"published_at":"2026-01-02T03:04:05Z"}`)}, {Key: "author", Type: "x.profile", ExternalId: "profile-123", DataJson: []byte(`{"username":"fixture","name":"Name","metadata":{"description":"bio","followers":12}}`), ResourceIndices: []uint32{0}}}, Relations: []*pb.EntityRelation{{Source: "post", Target: "author", Type: "authored_by"}}}, entityTypes: []*pb.EntityType{{Name: "x.post", JsonSchema: []byte(`{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"published_at":{"type":"string","format":"date-time"}}}`)}, {Name: "x.profile", JsonSchema: []byte(`{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}`)}}, extraResources: []*pb.Resource{{Url: server.URL, Kind: "image", Purpose: "avatar"}}, sourceResponses: []*pb.SourceResponse{
		{Body: raw, ContentType: "application/json", SourceUrl: "https://x.com/i/api/graphql/fixture", Visibility: pb.Visibility_VISIBILITY_PRIVATE},
		{Body: []byte(`{"public":true}`), ContentType: "application/json", SourceUrl: "https://api.fxtwitter.com/fixture", Visibility: pb.Visibility_VISIBILITY_PUBLIC},
	}}
	q, e := river.NewClient(riverpgxv5.New(db.Pool), &river.Config{})
	must(t, e)
	s := &Service{DB: db, Queue: q, Adapter: f, Config: Defaults(), HTTP: server.Client(), Blobs: &memoryBlob{m: map[string][]byte{}}}
	finish := func(tenant string, in domain.CaptureInput) domain.Archive {
		t.Helper()
		j, e := s.Submit(ctx, tenant, in)
		must(t, e)
		must(t, s.capture(ctx, store.Task{Tenant: tenant, ID: j.ID}))
		var aa []domain.Asset
		must(t, db.Tx(ctx, tenant, func(tx pgx.Tx) error { var err error; aa, err = assets(ctx, tx, j.ID); return err }))
		for _, a := range aa {
			must(t, s.download(ctx, store.Task{Tenant: tenant, ID: a.ID}))
		}
		must(t, s.finalize(ctx, tenant, j.ID))
		a, e := s.Archive(ctx, tenant, j.ArchiveID)
		must(t, e)
		return a
	}
	a := finish(tenants[0], domain.CaptureInput{URL: "https://x.com/a/status/99190011"})
	author := func(a domain.Archive) domain.Entity {
		t.Helper()
		if a.Graph != nil {
			for _, e := range a.Graph.Entities {
				if e.Key == "author" {
					return e
				}
			}
		}
		t.Fatal("author missing")
		return domain.Entity{}
	}
	if author(a).ID == "" || len(author(a).Assets) != 1 || author(a).Assets[0].State != "ready" || len(a.Assets) != 0 {
		t.Fatal("entity resources missing or sent as presentation")
	}
	profile, e := s.Entity(ctx, tenants[0], author(a).ID)
	must(t, e)
	var data map[string]any
	must(t, json.Unmarshal(profile.Data, &data))
	if profile.ExternalID != "profile-123" || data["username"] != "fixture" {
		t.Fatal("wrong entity")
	}
	if _, e = s.Entity(ctx, tenants[2], profile.ID); e == nil {
		t.Fatal("unsaved entity accessible")
	}
	sources, e := s.Sources(ctx, tenants[0], a.ID)
	must(t, e)
	if len(sources) != 2 {
		t.Fatal("raw response missing")
	}
	var privateID, publicID string
	for _, v := range sources {
		if v.Visibility == "private" {
			privateID = v.ID
		} else {
			publicID = v.ID
		}
	}
	body, e := s.Source(ctx, tenants[0], privateID)
	must(t, e)
	if !bytes.Equal(body.Body, raw) {
		t.Fatal("raw response was reserialized")
	}
	_, e = s.Submit(ctx, tenants[1], domain.CaptureInput{URL: a.URL})
	must(t, e)
	if _, e = s.Source(ctx, tenants[1], privateID); e == nil {
		t.Fatal("shared archive exposed account raw")
	}
	list, e := s.Sources(ctx, tenants[1], a.ID)
	must(t, e)
	if len(list) != 1 || list[0].ID != publicID {
		t.Fatal("incorrect raw list isolation")
	}
	usageA, e := s.Usage(ctx, tenants[0])
	must(t, e)
	usageB, e := s.Usage(ctx, tenants[1])
	must(t, e)
	if usageA.Used-usageB.Used != int64(len(raw)) {
		t.Fatalf("private raw quota leaked across tenants: %d", usageA.Used-usageB.Used)
	}
	// Raw observations survive unchanged content without manufacturing a content revision.
	b := finish(tenants[0], domain.CaptureInput{RefreshID: a.ID})
	if b.RevisionID != a.RevisionID {
		t.Fatal("unchanged metadata created version")
	}
	later, e := s.Usage(ctx, tenants[0])
	must(t, e)
	if later.Reserved != 0 || later.Used <= usageA.Used {
		t.Fatal("raw observations not settled")
	}
	// A second tenant may reuse the same public profile from a different post.
	f.sourceResponses = nil
	c := finish(tenants[1], domain.CaptureInput{URL: "https://x.com/a/status/99190012"})
	if author(c).ID != profile.ID {
		t.Fatal("public profile duplicated")
	}
	f.graph.Entities[1].DataJson = []byte(`{"username":"fixture","name":"New name","metadata":{"description":"bio","followers":12}}`)
	d := finish(tenants[1], domain.CaptureInput{RefreshID: c.ID})
	if author(d).VersionID == author(c).VersionID || d.RevisionID == c.RevisionID {
		t.Fatal("profile change lost")
	}
	// Removing the raw owner's reference schedules private raw independently of the shared post.
	must(t, s.DeleteArchive(ctx, tenants[0], a.ID))
	var released int
	must(t, admin.Pool.QueryRow(ctx, `SELECT count(*) FROM source_responses WHERE id=$1 AND unreferenced_at IS NOT NULL`, privateID).Scan(&released))
	if released != 1 {
		t.Fatal("private raw retention missing")
	}
	var removed int
	must(t, admin.Pool.QueryRow(ctx, `SELECT collect_unreferenced_archives(interval '0 seconds')`).Scan(&removed))
	if _, e = s.Source(ctx, tenants[1], publicID); e != nil {
		t.Fatal("public raw removed while saved")
	}
	must(t, admin.Pool.QueryRow(ctx, `SELECT count(*) FROM source_responses WHERE id=$1`, privateID).Scan(&released))
	if released != 0 {
		t.Fatal("private raw not collected")
	}
	// The same persistence path supports adapter types the core has never seen.
	f.public = false
	f.graph.Entities[0].Type = "weather.report"
	f.graph.Entities[1].Type = "weather.station"
	f.graph.Entities[1].ExternalId = "99190013"
	f.entityTypes[0].Name = "weather.report"
	f.entityTypes[1].Name = "weather.station"
	one := finish(tenants[0], domain.CaptureInput{URL: "https://x.com/a/status/99190013"})
	two := finish(tenants[2], domain.CaptureInput{URL: "https://x.com/a/status/99190013"})
	if author(one).ID == author(two).ID {
		t.Fatal("private entities merged across tenants")
	}
	if _, err := s.Entity(ctx, tenants[2], author(one).ID); err == nil {
		t.Fatal("private entity leaked")
	}
	for _, entity := range one.Graph.Entities {
		if entity.Key == one.Graph.Root && entity.ID == author(one).ID {
			t.Fatal("different types with identical external IDs merged")
		}
	}
}
