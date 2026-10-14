package app

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// LibrarySize is what deleting everything would remove.
type LibrarySize struct {
	Collections int64 `json:"collections"`
	Records     int64 `json:"records"`
	// Running counts records whose capture has not finished.
	Running int64 `json:"running"`
}

func (s *Service) LibrarySize(ctx context.Context, tenant string) (v LibrarySize, err error) {
	err = s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT (SELECT count(*) FROM tenant_collections),
 (SELECT count(*) FROM (`+captureRecordSQL+`) r),
 (SELECT count(*) FROM (`+captureRecordSQL+` AND c.state IN('queued','downloading')) r)`).Scan(&v.Collections, &v.Records, &v.Running)
	})
	return
}

// DeleteAll removes the tenant's saved collections and capture records made
// up to before. The cutoff keeps a retry from deleting what was saved after the
// user's request. Shared content stays until retention collects it, and other
// tenants keep theirs.
func (s *Service) DeleteAll(ctx context.Context, tenant string, before time.Time) (v LibrarySize, err error) {
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
		if err = tx.QueryRow(ctx, `SELECT count(*) FROM (`+captureRecordSQL+` AND s.created_at <= $1) r`, before).Scan(&v.Records); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `DELETE FROM tenant_collections WHERE tenant_id=$1 AND created_at <= $2`, tenant, before)
		if err != nil {
			return err
		}
		v.Collections = tag.RowsAffected()
		if err := pruneTags(ctx, tx); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `SELECT mark_unreferenced(id) FROM unnest($1::uuid[]) AS id`, ids); err != nil {
			return err
		}
		// Removing the submissions also ends what they would still start: a
		// related task or continuation page finds its submission gone and stops.
		// Deliveries waiting on them have nothing left to send.
		removed, err := tx.Query(ctx, `DELETE FROM submissions WHERE tenant_id=$1 AND created_at <= $2 RETURNING id::text`, tenant, before)
		if err != nil {
			return err
		}
		gone, err := pgx.CollectRows(removed, pgx.RowTo[string])
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE channel_work SET state='done',lease_until=NULL WHERE kind='delivery' AND state='pending' AND resource=ANY($1::text[])`, gone)
		return err
	})
	if err != nil {
		v = LibrarySize{}
	}
	return
}
