package telegram

import (
	"testing"

	"monitor/internal/domain"
)

func TestCollectionAuthorURLUsesOnlyRootAuthor(t *testing.T) {
	g := &domain.EntityGraph{Root: "post", Entities: []domain.Entity{
		{Key: "other", Type: "x.profile", Data: []byte(`{"username":"other"}`)},
		{Key: "author", Type: "x.profile", ExternalID: "123", Data: []byte(`{"username":"fixture"}`)},
	}, Relations: []domain.EntityRelation{{Source: "post", Target: "author", Type: "authored_by"}}}
	a := domain.Collection{Graph: g}
	if got := CollectionAuthorURL(a); got != "https://x.com/fixture" {
		t.Fatal(got)
	}
	g.Root = "author"
	g.Relations = nil
	if got := CollectionAuthorURL(a); got != "https://x.com/fixture" {
		t.Fatal(got)
	}
	g.Entities[1].Data = []byte(`{"username":"unsafe/?x"}`)
	if got := CollectionAuthorURL(a); got != "https://x.com/i/user/123" {
		t.Fatal(got)
	}
	g.Entities[1].Type = "other.profile"
	if got := CollectionAuthorURL(a); got != "" {
		t.Fatal("wrong platform", got)
	}
	if got := CollectionAuthorURL(domain.Collection{}); got != "" {
		t.Fatal(got)
	}
}
