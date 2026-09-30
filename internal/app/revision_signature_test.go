package app

import (
	"bytes"
	"encoding/json"
	"testing"

	"monitor/internal/domain"
)

func TestRevisionContext(t *testing.T) {
	p := Payload{Text: "post", AuthorName: "Old author", Summary: "Old author: post", Graph: &domain.EntityGraph{
		Root: "post",
		Entities: []domain.Entity{
			{Key: "post", Type: "example.post", ExternalID: "1", Data: json.RawMessage(`{"text":"post"}`), ResourceIndices: []uint32{0}},
			{Key: "author", Type: "example.profile", ExternalID: "2", Data: json.RawMessage(`{"name":"Old author","followers":1}`), ResourceIndices: []uint32{1}, ContextOnly: true},
		},
	}}
	aa := []domain.Asset{{Position: 0, Hash: "post-image", State: "ready"}, {Position: 1, Hash: "old-avatar", State: "ready", Purpose: "avatar"}}
	before := revisionSignature(p, aa, p.Graph)
	p.AuthorName = "New author"
	p.Summary = "New author: post"
	p.Graph.Entities[1].Data = json.RawMessage(`{"name":"New author","username":"new","followers":99}`)
	p.Graph.Entities[1].VersionID = "new-entity-version"
	aa[1].Hash = "new-avatar"
	if !bytes.Equal(before, revisionSignature(p, aa, p.Graph)) {
		t.Fatal("author fields or avatar affected the post revision")
	}
	aa[0].Hash = "new-post-image"
	if bytes.Equal(before, revisionSignature(p, aa, p.Graph)) {
		t.Fatal("post media change ignored")
	}
	p.Graph.Root = "author"
	p.Graph.Entities = p.Graph.Entities[1:]
	p.Graph.Entities[0].ContextOnly = false
	before = revisionSignature(p, aa, p.Graph)
	p.Graph.Entities[0].Data = json.RawMessage(`{"name":"New author","followers":100}`)
	if bytes.Equal(before, revisionSignature(p, aa, p.Graph)) {
		t.Fatal("standalone profile statistics change ignored")
	}
}
