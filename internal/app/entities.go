package app

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	pb "monitor/api/adapter/v1"
	"monitor/internal/adapter"
	"monitor/internal/domain"
)

func (s *Service) entityGraph(ctx context.Context, r *pb.FetchResponse) (*domain.EntityGraph, error) {
	if r.Graph == nil {
		return nil, nil
	}
	rootID := r.ExternalId
	if r.CanonicalTarget != nil {
		rootID = r.CanonicalTarget.ExternalId
	}
	g := r.Graph
	if len(g.Entities) == 0 || len(g.Entities) > 32 || len(g.Relations) > 128 {
		return nil, &PermanentError{"invalid entity graph size"}
	}
	schemas := s.EntitySchemas
	providers := s.Providers
	if schemas == nil || providers == nil {
		ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		d, err := s.Adapter.Describe(ctx, &pb.DescribeRequest{})
		if err != nil {
			return nil, err
		}
		if err = adapter.Validate(d); err != nil {
			return nil, err
		}
		schemas, err = adapter.CompileEntityTypes(d)
		if err != nil {
			return nil, err
		}
		providers = d.Providers
	}
	allowed := map[string]bool{}
	for _, p := range providers {
		if p.Id == r.ProviderId && adapter.Supports(p, adapter.EntityGraph, 1, 0) {
			for _, name := range p.EntityTypes {
				allowed[name] = true
			}
		}
	}
	out := &domain.EntityGraph{Root: g.Root, Relations: []domain.EntityRelation{}}
	keys, identities := map[string]bool{}, map[string]bool{}
	total := 0
	for _, e := range g.Entities {
		if e == nil || (e.ContextOnly && e.Key == g.Root) || !adapter.EntityName.MatchString(e.Key) || keys[e.Key] || !allowed[e.Type] || e.ExternalId == "" || len(e.ExternalId) > 200 || strings.ContainsRune(e.ExternalId, 0) || identities[e.Type+"\x00"+e.ExternalId] {
			return nil, &PermanentError{"invalid entity identity or undeclared type"}
		}
		keys[e.Key], identities[e.Type+"\x00"+e.ExternalId] = true, true
		schema, ok := schemas[e.Type]
		if !ok {
			return nil, &PermanentError{"undeclared entity schema"}
		}
		total += len(e.DataJson) + len(schema.JSON)
		if total > 2<<20 {
			return nil, &PermanentError{"entity graph exceeds limit"}
		}
		data, err := schema.Validate(e.DataJson)
		if err != nil {
			return nil, &PermanentError{"entity data does not match adapter schema"}
		}
		seen := map[uint32]bool{}
		for _, i := range e.ResourceIndices {
			if int(i) >= len(r.Resources) || seen[i] {
				return nil, &PermanentError{"invalid entity resource reference"}
			}
			seen[i] = true
		}
		out.Entities = append(out.Entities, domain.Entity{ContextOnly: e.ContextOnly, Key: e.Key, Type: e.Type, ExternalID: e.ExternalId, Data: data, Schema: schema.JSON, ResourceIndices: e.ResourceIndices})
		if e.Key == g.Root && e.ExternalId != rootID {
			return nil, &PermanentError{"entity root does not match capture identity"}
		}
	}
	if !keys[g.Root] {
		return nil, &PermanentError{"missing entity root"}
	}
	seen := map[string]bool{}
	for _, r := range g.Relations {
		if r == nil || !keys[r.Source] || !keys[r.Target] || !adapter.EntityName.MatchString(r.Type) {
			return nil, &PermanentError{"invalid entity relation"}
		}
		key := r.Source + "|" + r.Type + "|" + r.Target
		if seen[key] {
			return nil, &PermanentError{"duplicate entity relation"}
		}
		seen[key] = true
		out.Relations = append(out.Relations, domain.EntityRelation{Source: r.Source, Target: r.Target, Type: r.Type})
	}
	// Local graph ordering is not a content change.
	sort.Slice(out.Entities, func(i, j int) bool { return out.Entities[i].Key < out.Entities[j].Key })
	sort.Slice(out.Relations, func(i, j int) bool {
		a, b := out.Relations[i], out.Relations[j]
		return a.Source+"|"+a.Type+"|"+a.Target < b.Source+"|"+b.Type+"|"+b.Target
	})
	return out, nil
}

func persistEntities(ctx context.Context, tx pgx.Tx, tenant, cid string, p *Payload, assets []domain.Asset) error {
	if p.Graph == nil {
		return nil
	}
	var visibility, scope, platform string
	if err := tx.QueryRow(ctx, `SELECT c.visibility,a.scope,a.platform FROM captures c JOIN collections a ON a.id=c.collection_id WHERE c.id=$1`, cid).Scan(&visibility, &scope, &platform); err != nil {
		return err
	}
	for i := range p.Graph.Entities {
		e := &p.Graph.Entities[i]
		// Actual media bytes participate in versioning, never expiring download URLs.
		media := []any{}
		for _, index := range e.ResourceIndices {
			for _, a := range assets {
				if a.Position == int(index) {
					media = append(media, []any{a.Purpose, a.Hash, a.State, a.AltText, a.Sensitive, a.Error})
					break
				}
			}
		}
		body, err := json.Marshal([]any{e.Data, e.Schema, media})
		if err != nil {
			return err
		}
		if err = tx.QueryRow(ctx, `INSERT INTO entities(tenant_id,visibility,scope,platform,kind,external_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(data_scope,platform,scope,kind,external_id) DO UPDATE SET observed_at=now() RETURNING id`, tenant, visibility, scope, platform, e.Type, e.ExternalID).Scan(&e.ID); err != nil {
			return err
		}
		if err = tx.QueryRow(ctx, `INSERT INTO entity_versions(entity_id,tenant_id,visibility,content_hash,data,schema) VALUES($1,$2,$3,encode(digest($4::jsonb::text,'sha256'),'hex'),$5,$6) ON CONFLICT(entity_id,content_hash) DO UPDATE SET content_hash=excluded.content_hash RETURNING id`, e.ID, tenant, visibility, body, e.Data, e.Schema).Scan(&e.VersionID); err != nil {
			return err
		}
	}
	return nil
}

func linkEntities(ctx context.Context, tx pgx.Tx, tenant, cid, rid string, g *domain.EntityGraph) error {
	if g == nil {
		return nil
	}
	for _, e := range g.Entities {
		if _, err := tx.Exec(ctx, `INSERT INTO revision_entities(revision_id,entity_key,entity_version_id,tenant_id,visibility,is_root) SELECT $1,$2,$3,$4,visibility,$5 FROM captures WHERE id=$6`, rid, e.Key, e.VersionID, tenant, e.Key == g.Root, cid); err != nil {
			return err
		}
	}
	for _, r := range g.Relations {
		if _, err := tx.Exec(ctx, `INSERT INTO entity_relations(revision_id,source_key,target_key,kind,tenant_id,visibility) SELECT $1,$2,$3,$4,$5,visibility FROM captures WHERE id=$6`, rid, r.Source, r.Target, r.Type, tenant, cid); err != nil {
			return err
		}
	}
	return nil
}

func hydrateGraph(a *domain.Collection, p Payload, all []domain.Asset) {
	a.Graph = p.Graph
	a.Assets = []domain.Asset{}
	for _, asset := range all {
		if asset.Purpose == "" {
			a.Assets = append(a.Assets, asset)
		}
		if a.Graph != nil {
			for i := range a.Graph.Entities {
				e := &a.Graph.Entities[i]
				for _, pos := range e.ResourceIndices {
					if int(pos) == asset.Position {
						e.Assets = append(e.Assets, asset)
					}
				}
			}
		}
	}
}

func (s *Service) Entity(ctx context.Context, tenant, id string) (v domain.Entity, err error) {
	err = s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		var body []byte
		var cid, version string
		if err := tx.QueryRow(ctx, `SELECT r.payload,r.capture_id,ev.id FROM entity_versions ev JOIN revision_entities re ON re.entity_version_id=ev.id JOIN revisions r ON r.id=re.revision_id JOIN tenant_collections ta ON ta.collection_id=r.collection_id WHERE ev.entity_id=$1 ORDER BY ev.created_at DESC,r.created_at DESC,r.id DESC LIMIT 1`, id).Scan(&body, &cid, &version); err != nil {
			return err
		}
		var p Payload
		if err := json.Unmarshal(body, &p); err != nil {
			return err
		}
		aa, err := assets(ctx, tx, cid)
		if err != nil {
			return err
		}
		var a domain.Collection
		hydrateGraph(&a, p, aa)
		if a.Graph != nil {
			for _, e := range a.Graph.Entities {
				if e.ID == id && e.VersionID == version {
					v = e
					return nil
				}
			}
		}
		return fmt.Errorf("missing stored entity snapshot")
	})
	return
}

// Resolve links at read time: saved membership belongs to the requesting tenant,
// not to the shared entity snapshot. Only collections rooted at the entity count.
func linkSavedEntities(ctx context.Context, tx pgx.Tx, a *domain.Collection) error {
	if a.Graph == nil {
		return nil
	}
	ids := []string{}
	for i := range a.Graph.Entities {
		e := &a.Graph.Entities[i]
		e.SavedCollectionID = ""
		if e.ID != "" {
			ids = append(ids, e.ID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := tx.Query(ctx, `SELECT DISTINCT ON (ev.entity_id) ev.entity_id,c.id
 FROM entity_versions ev JOIN revision_entities re ON re.entity_version_id=ev.id AND re.is_root
 JOIN collections c ON c.current_revision=re.revision_id
 JOIN tenant_collections tc ON tc.collection_id=c.id
 WHERE ev.entity_id=ANY($1::uuid[]) ORDER BY ev.entity_id,tc.created_at DESC,c.id`, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	links := map[string]string{}
	for rows.Next() {
		var eid, cid string
		if err = rows.Scan(&eid, &cid); err != nil {
			return err
		}
		links[eid] = cid
	}
	if err = rows.Err(); err != nil {
		return err
	}
	for i := range a.Graph.Entities {
		e := &a.Graph.Entities[i]
		e.SavedCollectionID = links[e.ID]
	}
	return nil
}
