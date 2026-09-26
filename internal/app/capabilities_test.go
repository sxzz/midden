package app

import (
	"context"
	"encoding/base64"
	"errors"
	"testing"

	pb "monitor/api/adapter/v1"
	"monitor/internal/credentials"
	"monitor/internal/domain"
)

func TestUnsupportedOperationsBeforeSideEffects(t *testing.T) {
	vault, err := credentials.New(base64.StdEncoding.EncodeToString(make([]byte, 32)))
	if err != nil {
		t.Fatal(err)
	}
	s := &Service{Vault: vault, AdapterTLS: true, Providers: []*pb.Provider{
		{Id: "fxtwitter", Authentication: "none", Visibilities: []pb.Visibility{pb.Visibility_VISIBILITY_PUBLIC}},
		{Id: "x-session", Authentication: "session"},
	}}
	// No database or RPC client: rejection must precede persistence and credentials transmission.
	ctx := context.Background()
	if _, err := s.Submit(ctx, "tenant", domain.CaptureInput{URL: "https://x.com/a/status/20"}); !errors.Is(err, domain.ErrUnsupported) {
		t.Fatalf("submit: %v", err)
	}
	if _, err := s.ImportConnection(ctx, "tenant", "", "account", nil); !errors.Is(err, domain.ErrUnsupported) {
		t.Fatalf("import: %v", err)
	}
	if err := s.CheckConnection(ctx, "tenant", "id"); !errors.Is(err, domain.ErrUnsupported) {
		t.Fatalf("check: %v", err)
	}
	s.Providers[0].Capabilities = []*pb.Capability{{Name: "capture.fetch", Major: 2}}
	if _, err := s.providerVisibility(ctx, "fxtwitter"); !errors.Is(err, domain.ErrUnsupported) {
		t.Fatalf("unsupported major: %v", err)
	}
	s.Providers[0].Capabilities = []*pb.Capability{{Name: "capture.fetch", Major: 1, Minor: 9}}
	if v, err := s.providerVisibility(ctx, "fxtwitter"); err != nil || v != "public" {
		t.Fatalf("compatible minor: %s %v", v, err)
	}
}
