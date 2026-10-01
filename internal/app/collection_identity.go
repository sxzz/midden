package app

import (
	"context"

	"github.com/jackc/pgx/v5"
)

// Content is stored once per adapter object, so a saved collection is its own
// logical identity. These helpers keep library queries independent of that.
const savedIdentityMembersSQL = `SELECT member.id FROM collections member
 JOIN tenant_collections saved_member ON saved_member.collection_id=member.id
 WHERE member.id=$1`

func savedIdentityIDs(ctx context.Context, tx pgx.Tx, id string) ([]string, error) {
	rows, err := tx.Query(ctx, savedIdentityMembersSQL, id)
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

const latestIdentitySQL = `TRUE`

var identityStorageSQL = collectionStorageSQL

func savedIdentityStorage(ctx context.Context, tx pgx.Tx, id string) (int64, error) {
	var bytes int64
	err := tx.QueryRow(ctx, `SELECT `+identityStorageSQL+` FROM collections a JOIN tenant_collections saved_owner ON saved_owner.collection_id=a.id WHERE a.id=$1`, id).Scan(&bytes)
	return bytes, err
}
