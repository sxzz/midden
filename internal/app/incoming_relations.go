package app

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"

	"monitor/internal/domain"
)

// Incoming relations are a tenant-specific view of saved history. They never
// alter the captured graph, and a source must remain saved to contribute edges.
func attachIncomingRelations(ctx context.Context, tx pgx.Tx, collection *domain.Collection) error {
	collection.IncomingRelations = nil
	if collection.Graph == nil {
		return nil
	}
	var root string
	for _, entity := range collection.Graph.Entities {
		if entity.Key == collection.Graph.Root {
			root = entity.ID
			break
		}
	}
	if root == "" {
		return nil
	}
	rows, err := tx.Query(ctx, `WITH incoming AS (
 SELECT DISTINCT source.platform,source.kind,source.external_id,relation.kind AS relation_type
 FROM entities root
 JOIN entities target ON (target.platform,target.kind,target.external_id)=(root.platform,root.kind,root.external_id)
 JOIN entity_versions target_version ON target_version.entity_id=target.id
 JOIN revision_entities target_ref ON target_ref.entity_version_id=target_version.id
 JOIN entity_relations relation ON relation.revision_id=target_ref.revision_id AND relation.target_key=target_ref.entity_key
 JOIN revisions revision ON revision.id=relation.revision_id
 JOIN tenant_collections saved ON saved.collection_id=revision.collection_id
 JOIN revision_entities source_ref ON source_ref.revision_id=relation.revision_id AND source_ref.entity_key=relation.source_key
 JOIN entity_versions source_version ON source_version.id=source_ref.entity_version_id
 JOIN entities source ON source.id=source_version.entity_id
 WHERE root.id=$1 AND relation.kind IN ('reposted','quoted')
 )
 SELECT incoming.relation_type,latest.id,latest.version_id,incoming.kind,incoming.external_id,latest.data,latest.schema,
 COALESCE(author.entity,'null'::jsonb)
 FROM incoming CROSS JOIN LATERAL (
 SELECT source.id,version.id AS version_id,version.data,version.schema,ref.revision_id,ref.entity_key
 FROM entities source
 JOIN entity_versions version ON version.entity_id=source.id
 JOIN revision_entities ref ON ref.entity_version_id=version.id
 JOIN revisions revision ON revision.id=ref.revision_id
 JOIN tenant_collections saved ON saved.collection_id=revision.collection_id
 WHERE (source.platform,source.kind,source.external_id)=(incoming.platform,incoming.kind,incoming.external_id)
 ORDER BY revision.created_at DESC,version.created_at DESC,revision.id DESC LIMIT 1
 ) latest
 LEFT JOIN LATERAL (
 SELECT jsonb_build_object('id',identity.id,'version_id',version.id,'type',identity.kind,
 'external_id',identity.external_id,'data',version.data,'schema',version.schema) AS entity
 FROM entity_relations edge
 JOIN revision_entities ref ON ref.revision_id=edge.revision_id AND ref.entity_key=edge.target_key
 JOIN entity_versions version ON version.id=ref.entity_version_id
 JOIN entities identity ON identity.id=version.entity_id
 WHERE edge.revision_id=latest.revision_id AND edge.source_key=latest.entity_key AND edge.kind='authored_by'
 ORDER BY edge.target_key LIMIT 1
 ) author ON true
 ORDER BY incoming.relation_type,incoming.platform,incoming.kind,incoming.external_id`, root)
	if err != nil {
		return err
	}
	var sources domain.Collection
	sources.Graph = &domain.EntityGraph{}
	for rows.Next() {
		var incoming domain.IncomingRelation
		var authorJSON []byte
		entity := &incoming.Entity
		if err := rows.Scan(&incoming.Type, &entity.ID, &entity.VersionID, &entity.Type, &entity.ExternalID, &entity.Data, &entity.Schema, &authorJSON); err != nil {
			rows.Close()
			return err
		}
		entity.Key = fmt.Sprintf("incoming_%d", len(collection.IncomingRelations))
		if err := json.Unmarshal(authorJSON, &incoming.Author); err != nil {
			rows.Close()
			return err
		}
		if incoming.Author != nil {
			incoming.Author.Key = entity.Key + "_author"
		}
		collection.IncomingRelations = append(collection.IncomingRelations, incoming)
		sources.Graph.Entities = append(sources.Graph.Entities, *entity)
		if incoming.Author != nil {
			sources.Graph.Entities = append(sources.Graph.Entities, *incoming.Author)
			sources.Graph.Relations = append(sources.Graph.Relations, domain.EntityRelation{Source: entity.Key, Target: incoming.Author.Key, Type: authorRelation})
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if err := linkSavedEntities(ctx, tx, &sources); err != nil {
		return err
	}
	linked := make(map[string]domain.Entity, len(sources.Graph.Entities))
	for _, entity := range sources.Graph.Entities {
		linked[entity.Key] = entity
	}
	for i := range collection.IncomingRelations {
		incoming := &collection.IncomingRelations[i]
		incoming.Entity = linked[incoming.Entity.Key]
		if incoming.Author != nil {
			author := linked[incoming.Author.Key]
			incoming.Author = &author
		}
	}
	return nil
}
