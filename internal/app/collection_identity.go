package app

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5"
)

// Storage scopes preserve source permissions; the tenant's library groups the
// same adapter-declared object across those scopes into one logical collection.
const savedIdentityMembersSQL = `SELECT member.id FROM collections requested
 JOIN tenant_collections saved_requested ON saved_requested.collection_id=requested.id
 JOIN collections member ON (member.platform,member.kind,member.object_scope,member.external_id)=(requested.platform,requested.kind,requested.object_scope,requested.external_id)
 JOIN tenant_collections saved_member ON saved_member.collection_id=member.id
 WHERE requested.id=$1`

func savedIdentityIDs(ctx context.Context, tx pgx.Tx, id string) ([]string, error) {
	rows, err := tx.Query(ctx, savedIdentityMembersSQL+` ORDER BY member.id`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var member string
		if err := rows.Scan(&member); err != nil {
			return nil, err
		}
		ids = append(ids, member)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return nil, pgx.ErrNoRows
	}
	return ids, nil
}

// Used before paging, so duplicate source scopes never consume page slots.
const latestIdentitySQL = `NOT EXISTS(SELECT FROM collections newer JOIN tenant_collections saved_newer ON saved_newer.collection_id=newer.id WHERE (newer.platform,newer.kind,newer.object_scope,newer.external_id)=(a.platform,a.kind,a.object_scope,a.external_id) AND newer.current_revision IS NOT NULL AND (newer.observed_at,newer.id)>(a.observed_at,a.id))`

var identityStorageSQL = `(SELECT COALESCE(SUM(` + strings.ReplaceAll(collectionStorageSQL, "a.id", "stored.id") + `),0)::bigint FROM collections stored JOIN tenant_collections saved_storage ON saved_storage.collection_id=stored.id WHERE (stored.platform,stored.kind,stored.object_scope,stored.external_id)=(a.platform,a.kind,a.object_scope,a.external_id))`

func savedIdentityStorage(ctx context.Context, tx pgx.Tx, id string) (int64, error) {
	var bytes int64
	err := tx.QueryRow(ctx, `SELECT `+identityStorageSQL+` FROM collections a JOIN tenant_collections saved_owner ON saved_owner.collection_id=a.id WHERE a.id=$1`, id).Scan(&bytes)
	return bytes, err
}
