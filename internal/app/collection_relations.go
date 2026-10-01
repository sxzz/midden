package app

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5"

	"monitor/internal/domain"
)

// Relations in earlier collection pages remain relevant after the next page is
// captured. Only histories saved by this tenant participate in the annotation.
func annotateCollectionRelations(ctx context.Context, tx pgx.Tx, relatedTo string, ids []string, items map[string]domain.Collection) error {
	if relatedTo == "" || len(ids) == 0 {
		return nil
	}
	// Use the same direct-edge predicate as filtering and storage totals so
	// context nodes cannot acquire unrelated labels on otherwise valid results.
	relations := strings.ReplaceAll(relatedCollectionSQL, "NULLIF($16,'')", "$1")
	rows, err := tx.Query(ctx, `SELECT DISTINCT a.id,edge.kind FROM collections a
 JOIN tenant_collections saved_candidate ON saved_candidate.collection_id=a.id
 CROSS JOIN LATERAL (SELECT head.* FROM revisions head WHERE head.collection_id=a.id ORDER BY head.created_at DESC,head.id DESC LIMIT 1) r
 CROSS JOIN LATERAL (`+relations+`) edge
 WHERE a.id=ANY($2::uuid[]) ORDER BY a.id,edge.kind`, relatedTo, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id, kind string
		if err = rows.Scan(&id, &kind); err != nil {
			return err
		}
		item := items[id]
		item.RelationTypes = append(item.RelationTypes, kind)
		items[id] = item
	}
	return rows.Err()
}
