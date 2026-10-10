package adapter

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	hp "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	pb "monitor/api/adapter/v1"
	"monitor/internal/adapter/adaptertest"
)

func TestTypeScriptTLSProtocol(t *testing.T) {
	root, e := filepath.Abs("../..")
	if e != nil {
		t.Fatal(e)
	}
	if _, e = os.Stat(filepath.Join(root, "adapters/x/dist/server.js")); e != nil {
		t.Skip("pnpm build required")
	}
	fixture, e := os.ReadFile(filepath.Join(root, "adapters/x/src/testdata/post.json"))
	if e != nil {
		t.Fatal(e)
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/99" {
			w.Header().Set("Retry-After", "7")
			w.WriteHeader(429)
			return
		}
		if r.Header.Get("Cookie") != "" {
			t.Error("public API received credentials")
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(fixture)
	}))
	defer upstream.Close()
	addresses, ca := adaptertest.Start(t, upstream.URL, "")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	conn, e := Dial(addresses[0], "fixture", ca)
	if e != nil {
		t.Fatal(e)
	}
	defer conn.Close()
	client := pb.NewAdapterClient(conn)
	d, e := client.Describe(ctx, &pb.DescribeRequest{})
	if e != nil {
		t.Fatal(e)
	}
	if e = Validate(d); e != nil {
		t.Fatal(e)
	}
	if d.DisplayName != "X" {
		t.Fatal("adapter display name lost over RPC")
	}
	if len(d.Providers) != 2 {
		t.Fatal("missing session provider")
	}
	if !Supports(d.Providers[0], CaptureFetch, 1, 0) || Supports(d.Providers[0], ConnectionCheck, 1, 0) || !Supports(d.Providers[1], ConnectionCheck, 1, 0) {
		t.Fatal("provider capability declarations did not survive the wire")
	}
	if _, e = hp.NewHealthClient(conn).Check(ctx, &hp.HealthCheckRequest{}); e != nil {
		t.Fatal(e)
	}
	// The fixed fixture ID is read through the wire rather than a live third-party API.
	var data struct {
		Status struct {
			ID string `json:"id"`
		} `json:"status"`
	}
	if e = json.Unmarshal(fixture, &data); e != nil {
		t.Fatal(e)
	}
	id := data.Status.ID
	resolved, e := client.Resolve(ctx, &pb.ResolveRequest{Url: fmt.Sprintf("https://twitter.com/fixture/status/%s?test=1", id)})
	if e != nil || resolved.GetExternalId() != id || resolved.GetPlatform() != "x" || resolved.GetKind() != "post" {
		t.Fatal("target lost over RPC", e)
	}
	prepared, e := client.PrepareCredential(ctx, &pb.PrepareCredentialRequest{ProviderId: "x-session", Input: []byte("{\"auth_token\":\"aaaaaaaaaaaaaaaaaaaa\",\"csrf_token\":\"bbbbbbbbbbbbbbbbbbbb\"}")})
	if e != nil || len(prepared.GetCredential().GetData()) == 0 {
		t.Fatal("opaque credential lost over RPC", e)
	}

	r, e := client.Fetch(ctx, &pb.FetchRequest{Url: fmt.Sprintf("https://x.com/i/web/status/%s", id), ExternalId: id, Platform: "x", Kind: "post", ProviderId: "fxtwitter", AccessScope: "public"})
	if e != nil {
		t.Fatal(e)
	}
	if r.Text == "" || r.Visibility != pb.Visibility_VISIBILITY_PUBLIC || r.Graph == nil || len(r.Graph.Entities) < 2 || len(r.SourceResponses) != 1 || string(r.SourceResponses[0].Body) != string(fixture) {
		t.Fatal("public fixture lost over RPC")
	}
	var trailer metadata.MD
	_, e = client.Fetch(ctx, &pb.FetchRequest{Url: "https://x.com/i/web/status/99", ExternalId: "99", Platform: "x", Kind: "post", ProviderId: "fxtwitter", AccessScope: "public"}, grpc.Trailer(&trailer))
	if status.Code(e) != codes.Unavailable || len(trailer.Get("retry-after")) != 1 || trailer.Get("retry-after")[0] != "7" {
		t.Fatal("retry-after lost over RPC", e, trailer)
	}
	if _, e = client.CheckConnection(ctx, &pb.CheckConnectionRequest{ProviderId: "x-session"}); status.Code(e) != codes.InvalidArgument {
		t.Fatal("credential validation lost over RPC", e)
	}
	bad, e := Dial(addresses[0], "wrong", ca)
	if e != nil {
		t.Fatal(e)
	}
	defer bad.Close()
	if _, e = pb.NewAdapterClient(bad).Describe(ctx, &pb.DescribeRequest{}); status.Code(e) != codes.Unauthenticated {
		t.Fatal(e)
	}
	instagramConn, e := Dial(addresses[1], "fixture", ca)
	if e != nil {
		t.Fatal(e)
	}
	defer instagramConn.Close()
	instagram := pb.NewAdapterClient(instagramConn)
	descriptor, e := instagram.Describe(ctx, &pb.DescribeRequest{})
	if e != nil {
		t.Fatal(e)
	}
	if e = Validate(descriptor); e != nil {
		t.Fatal(e)
	}
	if descriptor.AdapterId != "instagram" || descriptor.DisplayName != "Instagram" || len(descriptor.Providers) != 1 {
		t.Fatal("Instagram discovery missing", descriptor)
	}
	resolvedIG, e := instagram.Resolve(ctx, &pb.ResolveRequest{Url: "https://instagram.com/reel/C/?igsh=fixture"})
	if e != nil || resolvedIG.ExternalId != "2" || resolvedIG.Platform != "instagram" {
		t.Fatal("Instagram resolution", resolvedIG, e)
	}
	if descriptor.Providers[0].Authentication != "session" || len(descriptor.Providers[0].Visibilities) != 1 || descriptor.Providers[0].Visibilities[0] != pb.Visibility_VISIBILITY_PRIVATE {
		t.Fatal("Instagram must require private account execution", descriptor)
	}
	if _, e = instagram.Fetch(ctx, &pb.FetchRequest{Url: resolvedIG.Url, ExternalId: resolvedIG.ExternalId, Platform: "instagram", Kind: "post", ProviderId: "instagram-session"}); status.Code(e) != codes.InvalidArgument {
		t.Fatal("Instagram accepted missing connection", e)
	}
	preparedIG, e := instagram.PrepareCredential(ctx, &pb.PrepareCredentialRequest{ProviderId: "instagram-session", Input: []byte("c2Vzc2lvbmlkPWZpeHR1cmUtc2Vzc2lvbg==")})
	if e != nil {
		t.Fatal(e)
	}
	identityIG, e := instagram.CheckConnection(ctx, &pb.CheckConnectionRequest{ProviderId: "instagram-session", Credential: preparedIG.Credential})
	if e != nil || identityIG.AccountId != "77" || identityIG.Username != "fixture.name" {
		t.Fatal("Instagram account verification", identityIG, e)
	}
	privateIG, e := instagram.Fetch(ctx, &pb.FetchRequest{Url: "https://www.instagram.com/p/D/", ExternalId: "3", Platform: "instagram", Kind: "post", ProviderId: "instagram-session", ConnectionId: "fixture", AccessScope: "connection:fixture", Credential: preparedIG.Credential})
	if e != nil || privateIG.Text != "Instagram private" || privateIG.Visibility != pb.Visibility_VISIBILITY_PRIVATE {
		t.Fatal("Instagram private capture", privateIG, e)
	}
	for _, source := range privateIG.SourceResponses {
		if source.Visibility != pb.Visibility_VISIBILITY_PRIVATE {
			t.Fatal("Instagram raw account response leaked")
		}
	}
	accessIG, e := instagram.CheckAccess(ctx, &pb.CheckAccessRequest{Url: "https://www.instagram.com/p/D/", Target: &pb.ObjectRef{Platform: "instagram", Kind: "post", ExternalId: "3"}, ProviderId: "instagram-session", ConnectionId: "fixture", AccessScope: "connection:fixture", Credential: preparedIG.Credential})
	if e != nil || accessIG.Visibility != pb.Visibility_VISIBILITY_PRIVATE || len(accessIG.Accessible) != 1 {
		t.Fatal("Instagram account access", accessIG, e)
	}
	profileIG, e := instagram.Fetch(ctx, &pb.FetchRequest{Url: "https://www.instagram.com/fixture.name/", ExternalId: "handle:fixture.name", Platform: "instagram", Kind: "profile", ProviderId: "instagram-session", ConnectionId: "fixture", AccessScope: "connection:fixture", Credential: preparedIG.Credential, PageSize: 1})
	if e != nil || profileIG.CanonicalTarget.GetExternalId() != "77" || len(profileIG.RelatedTargets) != 2 || profileIG.NextPageCursor == "" || profileIG.Incomplete {
		t.Fatal("Instagram authenticated profile pagination", profileIG, e)
	}
	continuedIG, e := instagram.Fetch(ctx, &pb.FetchRequest{Url: profileIG.CanonicalTarget.Url, ExternalId: "77", Platform: "instagram", Kind: "profile", ProviderId: "instagram-session", ConnectionId: "fixture", AccessScope: "connection:fixture", Credential: preparedIG.Credential, PageSize: 1, PageCursor: profileIG.NextPageCursor})
	if e != nil || len(continuedIG.RelatedTargets) != 1 || continuedIG.NextPageCursor != "" || continuedIG.Incomplete {
		t.Fatal("Instagram authenticated continuation", continuedIG, e)
	}
	listedIG, e := instagram.Fetch(ctx, &pb.FetchRequest{Url: "https://www.instagram.com/p/C/", ExternalId: "2", Platform: "instagram", Kind: "post", ProviderId: "instagram-session", ConnectionId: "fixture", AccessScope: "connection:fixture", Credential: preparedIG.Credential, Automatic: true})
	if e != nil || listedIG.Text != "Instagram account" || listedIG.Visibility != pb.Visibility_VISIBILITY_PRIVATE {
		t.Fatal("Instagram listed post snapshot", listedIG, e)
	}
	expired, stop := context.WithCancel(ctx)
	stop()
	if _, e = client.Describe(expired, &pb.DescribeRequest{}); status.Code(e) != codes.Canceled {
		t.Fatal(e)
	}
}
