package app

import (
	"encoding/json"

	"monitor/internal/domain"
)

// Context entities retain their snapshots and independent entity versions.
// Only their stable identity participates in the enclosing collection revision.
func revisionSignature(p Payload, assets []domain.Asset, policy *domain.EntityGraph) []byte {
	context := map[string]bool{}
	if policy != nil {
		for _, e := range policy.Entities {
			if e.ContextOnly && e.Key != policy.Root {
				context[e.Key] = true
			}
		}
	}
	contextMedia, contentMedia := map[int]bool{}, map[int]bool{}
	graph := p.Graph
	if graph != nil {
		copyGraph := *graph
		copyGraph.Entities = append([]domain.Entity(nil), graph.Entities...)
		for i, e := range copyGraph.Entities {
			for _, pos := range e.ResourceIndices {
				if context[e.Key] {
					contextMedia[int(pos)] = true
				} else {
					contentMedia[int(pos)] = true
				}
			}
			if context[e.Key] {
				copyGraph.Entities[i] = domain.Entity{Key: e.Key, Type: e.Type, ExternalID: e.ExternalID}
			}
		}
		graph = &copyGraph
	}
	type sig struct {
		Purpose, Hash, AltText string
		Sensitive              bool
		State, Error           string
	}
	ss := []sig{}
	for _, a := range assets {
		if contextMedia[a.Position] && !contentMedia[a.Position] {
			continue
		}
		ss = append(ss, sig{a.Purpose, a.Hash, a.AltText, a.Sensitive, a.State, a.Error})
	}
	author, summary := p.AuthorName, p.Summary
	if len(context) > 0 {
		author, summary = "", ""
	}
	body, _ := json.Marshal(struct {
		Text, Kind, Summary, AuthorName, PublishedAt string
		Graph                                        *domain.EntityGraph
		Warnings                                     []string
		Assets                                       []sig
	}{p.Text, p.TextKind, summary, author, p.PublishedAt, graph, p.Warnings, ss})
	return body
}
