package app

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// The cutoff keeps retries from deleting content saved after the user's request.
func (s *Service) DeleteAllCollections(ctx context.Context, tenant string, before time.Time) (count int64, err error) {
	err = s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		if err := lockTenant(ctx, tx, tenant); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `SELECT a.id FROM collections a JOIN tenant_collections ta ON ta.collection_id=a.id WHERE ta.created_at <= $1 ORDER BY a.id FOR UPDATE OF a`, before)
		if err != nil {
			return err
		}
		ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
		if err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `DELETE FROM tenant_collections WHERE tenant_id=$1 AND created_at <= $2`, tenant, before)
		if err != nil {
			return err
		}
		if err := pruneTags(ctx, tx); err != nil {
			return err
		}
		count = tag.RowsAffected()
		_, err = tx.Exec(ctx, `SELECT mark_unreferenced(id) FROM unnest($1::uuid[]) AS id`, ids)
		return err
	})
	if err != nil {
		count = 0
	}
	return
}
