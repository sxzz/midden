package telegram

import (
	"testing"

	"monitor/internal/domain"
)

func TestInstagramProfilePresentation(t *testing.T) {
	a := domain.Collection{URL: "https://www.instagram.com/fixture.name/", Graph: &domain.EntityGraph{Root: "author", Entities: []domain.Entity{{Key: "author", Type: "instagram.profile", ExternalID: "77", Data: []byte(`{"username":"fixture.name","name":"Instagram Fixture","metadata":{"description":"Bio"}}`)}}}}
	if !IsProfileCollection(a) || CollectionAuthorURL(a) != a.URL || ProfileLinkLabel(a) != "在 Instagram 查看主页" {
		t.Fatal("Instagram profile presentation missing")
	}
	text, entities, _, ok := ProfilePresentation(a)
	if !ok || text != "Instagram Fixture\n@fixture.name\n\nBio" || len(entities) != 1 || entities[0].URL != a.URL {
		t.Fatal(text, entities)
	}
	a.Graph.Entities[0].Data = []byte(`{"username":"unsafe/?query"}`)
	if CollectionAuthorURL(a) != "" {
		t.Fatal("unsafe Instagram profile link")
	}
}

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
