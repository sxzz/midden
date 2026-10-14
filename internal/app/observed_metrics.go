package app

import (
	"context"
	"encoding/json"
	"sort"

	"github.com/jackc/pgx/v5"

	"monitor/internal/adapter"
	"monitor/internal/domain"
)

// Observed values (counts) are kept with each capture, not in versions: a
// version changes when the content does, while counts change on every look.

func metricsJSON(m map[string]map[string]json.RawMessage) []byte {
	if len(m) == 0 {
		return nil
	}
	b, _ := json.Marshal(m)
	return b
}

// stripMetrics removes observed values an older version still keeps in its
// data, so comparing it with a new capture sees content only.
func stripMetrics(g *domain.EntityGraph, paths map[string][]string) error {
	if g == nil {
		return nil
	}
	for i := range g.Entities {
		e := &g.Entities[i]
		data, _, err := adapter.SplitMetrics(e.Data, paths[e.Type])
		if err != nil {
			return err
		}
		e.Data = data
	}
	return nil
}

// overlayMetrics puts a capture's observed values back into the graph.
func overlayMetrics(a *domain.Collection, m map[string]map[string]json.RawMessage) error {
	if a.Graph == nil || len(m) == 0 {
		return nil
	}
	for i := range a.Graph.Entities {
		e := &a.Graph.Entities[i]
		data, err := adapter.OverlayMetrics(e.Data, m[metricKey(*e)])
		if err != nil {
			return err
		}
		e.Data = data
	}
	return nil
}

func captureMetrics(ctx context.Context, tx pgx.Tx, capture string) (map[string]map[string]json.RawMessage, error) {
	var raw []byte
	if err := tx.QueryRow(ctx, `SELECT metrics FROM captures WHERE id=$1`, capture).Scan(&raw); err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	var m map[string]map[string]json.RawMessage
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &m); err != nil {
			return nil, err
		}
	}
	return m, nil
}

// comparable leaves a payload's graph as content only: no database IDs, which
// follow from the content, and each local key replaced by the entity's
// identity, since adapters may number the same entities in another order.
func comparable(p Payload) Payload {
	if p.Graph == nil {
		return p
	}
	g := *p.Graph
	names := make(map[string]string, len(g.Entities))
	for _, e := range g.Entities {
		names[e.Key] = metricKey(e)
	}
	g.Root = names[g.Root]
	g.Entities = append([]domain.Entity(nil), g.Entities...)
	for i := range g.Entities {
		e := &g.Entities[i]
		e.Key, e.ID, e.VersionID = names[e.Key], "", ""
	}
	g.Relations = append([]domain.EntityRelation(nil), g.Relations...)
	for i := range g.Relations {
		r := &g.Relations[i]
		r.Source, r.Target = names[r.Source], names[r.Target]
	}
	sort.Slice(g.Entities, func(i, j int) bool { return g.Entities[i].Key < g.Entities[j].Key })
	sort.Slice(g.Relations, func(i, j int) bool {
		a, b := g.Relations[i], g.Relations[j]
		return a.Source+"|"+a.Type+"|"+a.Target < b.Source+"|"+b.Type+"|"+b.Target
	})
	p.Graph = &g
	return p
}
