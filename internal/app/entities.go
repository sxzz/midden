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
	if len(g.Entities) == 0 || len(g.Entities) > 512 || len(g.Relations) > 1024 {
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

// Entities and their versions are shared by identity; revisions decide who reads them.
func persistEntities(ctx context.Context, tx pgx.Tx, cid string, p *Payload, assets []domain.Asset) error {
	if p.Graph == nil {
		return nil
	}
	var platform string
	if err := tx.QueryRow(ctx, `SELECT a.platform FROM captures c JOIN collections a ON a.id=c.collection_id WHERE c.id=$1`, cid).Scan(&platform); err != nil {
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
		if err = tx.QueryRow(ctx, `INSERT INTO entities(platform,kind,external_id) VALUES($1,$2,$3) ON CONFLICT(platform,kind,external_id) DO UPDATE SET observed_at=now() RETURNING id`, platform, e.Type, e.ExternalID).Scan(&e.ID); err != nil {
			return err
		}
		if err = tx.QueryRow(ctx, `SELECT ensure_entity_version($1,$2::jsonb,$3,$4)`, e.ID, body, e.Data, e.Schema).Scan(&e.VersionID); err != nil {
			return err
		}
	}
	return nil
}

func linkEntities(ctx context.Context, tx pgx.Tx, rid string, g *domain.EntityGraph) error {
	if g == nil {
		return nil
	}
	for _, e := range g.Entities {
		if _, err := tx.Exec(ctx, `INSERT INTO revision_entities(revision_id,entity_key,entity_version_id,is_root) VALUES($1,$2,$3,$4)`, rid, e.Key, e.VersionID, e.Key == g.Root); err != nil {
			return err
		}
	}
	for _, r := range g.Relations {
		if _, err := tx.Exec(ctx, `INSERT INTO entity_relations(revision_id,source_key,target_key,kind) VALUES($1,$2,$3,$4)`, rid, r.Source, r.Target, r.Type); err != nil {
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
// Scope-specific snapshots may link across scopes when both the source entity
// and canonical target are visible and the tenant has saved the target.
//
// Both branches pin their starting point in a subquery that cannot be
// flattened (OFFSET 0). The planner underrates the row-level read check, so
// left free it walked every saved collection's head, or hashed every root in
// the database, running that check on each row.
func linkSavedEntities(ctx context.Context, tx pgx.Tx, collections ...*domain.Collection) error {
	ids := []string{}
	seen := map[string]bool{}
	for _, a := range collections {
		if a.Graph == nil {
			continue
		}
		for i := range a.Graph.Entities {
			e := &a.Graph.Entities[i]
			e.SavedCollectionID = ""
			e.Current = nil
			if e.ID != "" && !seen[e.ID] {
				ids = append(ids, e.ID)
				seen[e.ID] = true
			}
		}
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := tx.Query(ctx, `WITH candidates AS (
 SELECT rooted.entity_id,c.id,tc.created_at,0 AS priority
 FROM (SELECT ev.entity_id,re.revision_id FROM entity_versions ev
  JOIN revision_entities re ON re.entity_version_id=ev.id AND re.is_root
  WHERE ev.entity_id=ANY($1::uuid[]) OFFSET 0) rooted
 JOIN revisions rv ON rv.id=rooted.revision_id
 JOIN collections c ON c.id=rv.collection_id AND visible_head(c.id)=rv.id
 JOIN tenant_collections tc ON tc.collection_id=c.id
 UNION ALL
 SELECT source.id,c.id,tc.created_at,1 AS priority
 FROM entities source
 JOIN collection_identity_aliases alias ON alias.external_id=source.external_id
  AND alias.platform=source.platform
 JOIN collections c ON c.id=alias.collection_id AND c.platform=alias.platform
  AND c.kind=alias.kind AND c.object_scope=alias.object_scope
 JOIN tenant_collections tc ON tc.collection_id=c.id
 CROSS JOIN LATERAL (SELECT visible_head(c.id) AS id OFFSET 0) head
 JOIN revision_entities re ON re.revision_id=head.id AND re.is_root
 JOIN entity_versions ev ON ev.id=re.entity_version_id
 JOIN entities target ON target.id=ev.entity_id AND target.kind=source.kind
  AND target.platform=source.platform
 WHERE source.id=ANY($1::uuid[])
 ) SELECT DISTINCT ON (entity_id) entity_id,id FROM candidates
 ORDER BY entity_id,priority,created_at DESC,id`, ids)
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
	for _, a := range collections {
		if a.Graph == nil {
			continue
		}
		for i := range a.Graph.Entities {
			e := &a.Graph.Entities[i]
			e.SavedCollectionID = links[e.ID]
		}
	}
	if err = attachSavedAvatars(ctx, tx, collections...); err != nil {
		return err
	}
	return attachCurrentProfiles(ctx, tx, collections...)
}

// An entry keeps its author as captured, but reads with the author's newest
// version: names, protection and counts change after the fact. Only versions
// captured as a root, or as the root's own author, are complete; a quoted
// entry's author is often just a name. The entity a collection is about is
// never replaced, so its history still reads.
func attachCurrentProfiles(ctx context.Context, tx pgx.Tx, collections ...*domain.Collection) error {
	ids := []string{}
	seen := map[string]bool{}
	for _, a := range collections {
		if a.Graph == nil {
			continue
		}
		authors := graphAuthors(a.Graph)
		for _, e := range a.Graph.Entities {
			if authors[e.Key] && e.ID != "" && !seen[e.ID] {
				seen[e.ID] = true
				ids = append(ids, e.ID)
			}
		}
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := tx.Query(ctx, `SELECT latest.entity_id,latest.id,latest.data,a.id,a.purpose,a.position,a.alt_text,a.sensitive,a.state,a.error,coalesce(b.hash,''),coalesce(b.mime,''),coalesce(b.size,0),coalesce(b.object_key,''),EXISTS(SELECT FROM blob_thumbnails t WHERE t.blob_id=a.blob_id AND t.state='ready')
 FROM (SELECT DISTINCT ON (ev.entity_id) ev.entity_id,ev.id,ev.data,r.capture_id,r.payload,re.entity_key
  FROM entity_versions ev
  JOIN revision_entities re ON re.entity_version_id=ev.id
  JOIN revisions r ON r.id=re.revision_id
  WHERE ev.entity_id=ANY($1::uuid[]) AND (re.is_root OR EXISTS(SELECT FROM entity_relations edge
   JOIN revision_entities source ON source.revision_id=edge.revision_id AND source.entity_key=edge.source_key AND source.is_root
   WHERE edge.revision_id=re.revision_id AND edge.target_key=re.entity_key AND edge.kind=$2))
  ORDER BY ev.entity_id,r.created_at DESC,r.id DESC) latest
 LEFT JOIN LATERAL (SELECT asset.* FROM jsonb_array_elements(CASE WHEN jsonb_typeof(latest.payload->'graph'->'entities')='array' THEN latest.payload->'graph'->'entities' ELSE '[]' END) e
  JOIN assets asset ON asset.capture_id=latest.capture_id AND asset.purpose='avatar' AND asset.state='ready'
  WHERE e->>'key'=latest.entity_key AND jsonb_typeof(e->'resource_indices')='array' AND e->'resource_indices' @> to_jsonb(asset.position)
  ORDER BY asset.position LIMIT 1) a ON true
 LEFT JOIN blobs b ON b.id=a.blob_id`, ids, authorRelation)
	if err != nil {
		return err
	}
	defer rows.Close()
	current := map[string]*domain.EntityVersion{}
	for rows.Next() {
		var entity string
		var v domain.EntityVersion
		var assetID, purpose, alt, state, errText *string
		var position *int
		var sensitive *bool
		var hash, mime, key string
		var size int64
		var thumbnail bool
		if err = rows.Scan(&entity, &v.ID, &v.Data, &assetID, &purpose, &position, &alt, &sensitive, &state, &errText, &hash, &mime, &size, &key, &thumbnail); err != nil {
			return err
		}
		if assetID != nil {
			v.Assets = []domain.Asset{{ID: *assetID, Purpose: *purpose, Position: *position, AltText: *alt, Sensitive: *sensitive, State: *state, Error: *errText, Hash: hash, MIME: mime, Size: size, Key: key, Thumbnail: thumbnail}}
		}
		current[entity] = &v
	}
	if err = rows.Err(); err != nil {
		return err
	}
	for _, a := range collections {
		if a.Graph == nil {
			continue
		}
		authors := graphAuthors(a.Graph)
		for i := range a.Graph.Entities {
			e := &a.Graph.Entities[i]
			if v, ok := current[e.ID]; ok && authors[e.Key] && v.ID != e.VersionID {
				e.Current = v
			}
		}
	}
	return nil
}

func hasAvatar(e domain.Entity) bool {
	for _, a := range e.Assets {
		if a.Purpose == "avatar" && a.State == "ready" {
			return true
		}
	}
	return false
}

// A referenced account (a quoted post's author, say) is captured without its
// avatar. When the account is saved here, show the avatar of its own current
// version instead; it is readable wherever the saved collection is.
func attachSavedAvatars(ctx context.Context, tx pgx.Tx, collections ...*domain.Collection) error {
	ids := []string{}
	seen := map[string]bool{}
	for _, a := range collections {
		if a.Graph == nil {
			continue
		}
		for _, e := range a.Graph.Entities {
			if e.SavedCollectionID != "" && !hasAvatar(e) && !seen[e.SavedCollectionID] {
				seen[e.SavedCollectionID] = true
				ids = append(ids, e.SavedCollectionID)
			}
		}
	}
	if len(ids) == 0 {
		return nil
	}
	// Only the saved collection's root entity owns the avatar, never another
	// account mentioned in the same capture. One query for the whole batch.
	// Each head is resolved before the join (OFFSET 0): joined on visible_head()
	// directly, every revision in the database went through the read check.
	rows, err := tx.Query(ctx, `SELECT DISTINCT ON (c.id) c.id,a.id,a.purpose,a.position,a.alt_text,a.sensitive,a.state,a.error,coalesce(b.hash,''),coalesce(b.mime,''),coalesce(b.size,0),coalesce(b.object_key,''),EXISTS(SELECT FROM blob_thumbnails t WHERE t.blob_id=a.blob_id AND t.state='ready')
 FROM unnest($1::uuid[]) c(id)
 CROSS JOIN LATERAL (SELECT visible_head(c.id) AS id OFFSET 0) head
 JOIN revisions r ON r.id=head.id
 JOIN revision_entities re ON re.revision_id=r.id AND re.is_root
 CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(r.payload->'graph'->'entities')='array' THEN r.payload->'graph'->'entities' ELSE '[]' END) e
 JOIN assets a ON a.capture_id=r.capture_id AND a.purpose='avatar' AND a.state='ready'
 LEFT JOIN blobs b ON b.id=a.blob_id
 WHERE e->>'key'=re.entity_key AND jsonb_typeof(e->'resource_indices')='array' AND e->'resource_indices' @> to_jsonb(a.position)
 ORDER BY c.id,a.position`, ids)
	if err != nil {
		return err
	}
	avatars := map[string]domain.Asset{}
	for rows.Next() {
		var id string
		var a domain.Asset
		if err = rows.Scan(&id, &a.ID, &a.Purpose, &a.Position, &a.AltText, &a.Sensitive, &a.State, &a.Error, &a.Hash, &a.MIME, &a.Size, &a.Key, &a.Thumbnail); err != nil {
			rows.Close()
			return err
		}
		avatars[id] = a
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return err
	}
	for _, a := range collections {
		if a.Graph == nil {
			continue
		}
		for i := range a.Graph.Entities {
			e := &a.Graph.Entities[i]
			if avatar, ok := avatars[e.SavedCollectionID]; ok && !hasAvatar(*e) {
				e.Assets = append(e.Assets, avatar)
			}
		}
	}
	return nil
}

// graphAuthors lists the entities something in the graph is authored by,
// except the graph's own root.
func graphAuthors(g *domain.EntityGraph) map[string]bool {
	authors := map[string]bool{}
	for _, r := range g.Relations {
		if r.Type == authorRelation && r.Target != g.Root {
			authors[r.Target] = true
		}
	}
	return authors
}
