package app

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"google.golang.org/grpc"

	pb "monitor/api/adapter/v1"
	"monitor/internal/credentials"
	"monitor/internal/domain"
	"monitor/internal/store"
)

type instagramFixture struct {
	*fakeAdapter
	name string
}

func (f *instagramFixture) Describe(context.Context, *pb.DescribeRequest, ...grpc.CallOption) (*pb.DescribeResponse, error) {
	capabilities := []*pb.Capability{{Name: "capture.fetch", Major: 1}, {Name: "entity.graph", Major: 1}, {Name: "source.raw", Major: 1}, {Name: "capture.canonical", Major: 1}}
	d := &pb.DescribeResponse{ProtocolVersion: "1.0", AdapterId: "instagram", DisplayName: "Instagram", Hosts: []string{"instagram.com", "www.instagram.com"}, EntityTypes: []*pb.EntityType{{Name: "instagram.post", JsonSchema: []byte(`{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}`)}, {Name: "instagram.profile", JsonSchema: []byte(`{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}`)}}}
	d.Providers = []*pb.Provider{{Id: "instagram-session", Authentication: "session", DefaultProvider: true, Visibilities: []pb.Visibility{pb.Visibility_VISIBILITY_PRIVATE}, Capabilities: append(capabilities, &pb.Capability{Name: "connection.check", Major: 1}, &pb.Capability{Name: "credential.prepare", Major: 1}), EntityTypes: []string{"instagram.post", "instagram.profile"}}}
	return d, nil
}

func (f *instagramFixture) Resolve(_ context.Context, r *pb.ResolveRequest, _ ...grpc.CallOption) (*pb.ResolveResponse, error) {
	u, e := url.Parse(r.Url)
	if e != nil {
		return nil, e
	}
	kind, id := "post", strings.Trim(u.Path, "/")
	if strings.HasPrefix(id, "profile/") {
		kind, id = "profile", strings.TrimPrefix(id, "profile/")
	}
	return &pb.ResolveResponse{Url: r.Url, Platform: "instagram", Kind: kind, ExternalId: id}, nil
}

func (f *instagramFixture) Fetch(_ context.Context, r *pb.FetchRequest, _ ...grpc.CallOption) (*pb.FetchResponse, error) {
	visibility := pb.Visibility_VISIBILITY_PRIVATE
	rawVisibility := pb.Visibility_VISIBILITY_PRIVATE
	data := []byte(fmt.Sprintf(`{"text":%q}`, f.name))
	out := &pb.FetchResponse{ExternalId: r.ExternalId, ProviderId: r.ProviderId, Text: f.name, Visibility: visibility, Graph: &pb.EntityGraph{Root: "root", Entities: []*pb.Entity{{Key: "root", Type: "instagram." + r.Kind, ExternalId: r.ExternalId, DataJson: data}}}, SourceResponses: []*pb.SourceResponse{{Body: []byte(`{"source":"fixture"}`), ContentType: "application/json", SourceUrl: r.Url, Visibility: rawVisibility}}}
	if r.Kind == "profile" {
		out.CanonicalTarget = &pb.ResolveResponse{Url: "https://www.instagram.com/profile/" + r.ExternalId + "?name=" + url.QueryEscape(f.name), Platform: "instagram", Kind: "profile", ExternalId: r.ExternalId}
	}
	return out, nil
}

func TestInstagramTenantCollectionsAndCanonicalURL(t *testing.T) {
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
	queue, e := river.NewClient(riverpgxv5.New(db.Pool), &river.Config{})
	must(t, e)
	vault, e := credentials.New(base64.StdEncoding.EncodeToString(make([]byte, 32)))
	must(t, e)
	fake := &instagramFixture{fakeAdapter: &fakeAdapter{}, name: "first"}
	s := &Service{DB: db, Queue: queue, Vault: vault, AdapterTLS: true, Adapter: fake, Config: Defaults()}
	s.Config.Rate = 1000
	var owner, other string
	must(t, admin.Pool.QueryRow(ctx, "INSERT INTO tenants DEFAULT VALUES RETURNING id").Scan(&owner))
	must(t, admin.Pool.QueryRow(ctx, "INSERT INTO tenants DEFAULT VALUES RETURNING id").Scan(&other))
	finish := func(tenant string, input domain.CaptureInput) domain.Job {
		t.Helper()
		job, e := s.Submit(ctx, tenant, input)
		must(t, e)
		if job.State == "complete" || job.State == "partial" {
			return job
		}
		must(t, s.capture(ctx, store.Task{Tenant: tenant, ID: job.ID}))
		must(t, s.finalize(ctx, tenant, job.ID))
		job, e = s.Job(ctx, tenant, job.ID)
		must(t, e)
		return job
	}
	id := uuid.NewString()
	if _, e = s.Submit(ctx, owner, domain.CaptureInput{URL: "https://www.instagram.com/" + id}); !errors.Is(e, ErrAccountRequired) {
		t.Fatal("Instagram accepted anonymous submission", e)
	}
	if e = s.SelectAccount(ctx, owner, "instagram", ""); !errors.Is(e, ErrAccountRequired) {
		t.Fatal("Instagram accepted public selection", e)
	}
	connection, e := s.ImportConnection(ctx, owner, "", "Instagram", &pb.Credential{Data: []byte("session")})
	must(t, e)
	otherConnection, e := s.ImportConnection(ctx, other, "", "Instagram", &pb.Credential{Data: []byte("other-session")})
	must(t, e)
	private := finish(owner, domain.CaptureInput{URL: "https://www.instagram.com/" + id, ConnectionID: connection})
	if _, e = s.Collection(ctx, other, private.CollectionID); e == nil {
		t.Fatal("Instagram collection leaked before the other account captured it")
	}
	fake.name = "other-account-version"
	otherPrivate := finish(other, domain.CaptureInput{URL: "https://www.instagram.com/" + id, ConnectionID: otherConnection})
	if private.ID == otherPrivate.ID {
		t.Fatal("Instagram capture reused another account")
	}
	ownVersion, e := s.CaptureCollection(ctx, owner, private.ID)
	must(t, e)
	otherVersion, e := s.CaptureCollection(ctx, other, otherPrivate.ID)
	must(t, e)
	if ownVersion.Text != "first" || otherVersion.Text != "other-account-version" || ownVersion.RevisionID == otherVersion.RevisionID {
		t.Fatal("Instagram capture snapshots lost their account observations", ownVersion.Text, otherVersion.Text)
	}
	sources, e := s.Sources(ctx, owner, private.CollectionID)
	must(t, e)
	if len(sources) != 1 || sources[0].Visibility != "private" {
		t.Fatal("account raw was not private", sources)
	}
	if _, e = s.Source(ctx, other, sources[0].ID); e == nil {
		t.Fatal("Instagram account raw leaked")
	}
	if _, e = s.Submit(ctx, other, domain.CaptureInput{URL: "https://www.instagram.com/" + id, ConnectionID: connection}); e == nil {
		t.Fatal("another tenant used the Instagram account")
	}
	if _, e = s.SavePublicCollection(ctx, other, private.CollectionID); e == nil {
		t.Fatal("Instagram collection was shared")
	}
	page, e := s.Collections(ctx, owner, CollectionFilter{EntityType: "x.post,instagram.post"}, "")
	must(t, e)
	if len(page.Items) != 1 {
		t.Fatal("merged platform filter", len(page.Items))
	}
	profile := finish(owner, domain.CaptureInput{URL: "https://www.instagram.com/profile/" + id, ConnectionID: connection})
	fake.name = "renamed"
	renamed := finish(owner, domain.CaptureInput{RefreshID: profile.CollectionID})
	if renamed.CollectionID != profile.CollectionID {
		t.Fatal("profile identity changed on rename")
	}
	stored, e := s.Collection(ctx, owner, profile.CollectionID)
	must(t, e)
	if !strings.Contains(stored.URL, "name=renamed") {
		t.Fatal("canonical profile URL did not update", stored.URL)
	}
	must(t, s.RevokeConnection(ctx, owner, connection))
	if _, e = s.Submit(ctx, owner, domain.CaptureInput{RefreshID: private.CollectionID}); e == nil {
		t.Fatal("revoked account refresh silently switched to anonymous")
	}
}
