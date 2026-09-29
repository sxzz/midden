package telegram

import (
	"testing"

	"monitor/internal/domain"
)

func TestArchiveAuthorURLUsesOnlyRootAuthor(t *testing.T) {
	g := &domain.EntityGraph{Root: "post", Entities: []domain.Entity{
		{Key: "other", Type: "x.profile", Data: []byte(`{"username":"other"}`)},
		{Key: "author", Type: "x.profile", ExternalID: "123", Data: []byte(`{"username":"fixture"}`)},
	}, Relations: []domain.EntityRelation{{Source: "post", Target: "author", Type: "authored_by"}}}
	a := domain.Archive{Graph: g}
	if got := ArchiveAuthorURL(a); got != "https://x.com/fixture" {
		t.Fatal(got)
	}
	g.Root = "author"
	g.Relations = nil
	if got := ArchiveAuthorURL(a); got != "https://x.com/fixture" {
		t.Fatal(got)
	}
	g.Entities[1].Data = []byte(`{"username":"unsafe/?x"}`)
	if got := ArchiveAuthorURL(a); got != "https://x.com/i/user/123" {
		t.Fatal(got)
	}
	g.Entities[1].Type = "other.profile"
	if got := ArchiveAuthorURL(a); got != "" {
		t.Fatal("wrong platform", got)
	}
	if got := ArchiveAuthorURL(domain.Archive{}); got != "" {
		t.Fatal(got)
	}
}
