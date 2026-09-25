package app

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"monitor/internal/domain"
	"monitor/internal/store"
)

// Reuse immutable provider media within its visibility and access scope.
// The caller holds the media advisory lock until download or reuse completes.
func (s *Service) reuseMedia(ctx context.Context, t store.Task, scope, key string) (bool, error) {
	hit := false
	err := s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
		if err := lockTenant(ctx, tx, t.Tenant); err != nil {
			return err
		}
		var state, cid string
		var reserved int64
		if err := tx.QueryRow(ctx, `SELECT state,capture_id,reserved_bytes FROM assets WHERE id=$1 FOR UPDATE`, t.ID).Scan(&state, &cid, &reserved); err != nil {
			return err
		}
		if state != "pending" {
			hit = true
			return nil
		}
		var bid, hash string
		var size int64
		err := tx.QueryRow(ctx, `SELECT b.id,b.hash,b.size FROM assets a JOIN blobs b ON b.id=a.blob_id WHERE a.data_scope=$1 AND a.cache_key=$2 AND a.state='ready' LIMIT 1`, scope, key).Scan(&bid, &hash, &size)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		if size > s.Config.MaxVideoBytes {
			return &PermanentError{"media exceeds size limit"}
		}
		var counted bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(
 SELECT FROM assets a JOIN revisions r ON r.capture_id=a.capture_id JOIN tenant_archives ta ON ta.archive_id=r.archive_id JOIN blobs b ON b.id=a.blob_id WHERE b.hash=$1
 UNION ALL SELECT FROM assets a JOIN blobs b ON b.id=a.blob_id WHERE a.capture_id=$2 AND b.hash=$1 AND a.state='ready')`, hash, cid).Scan(&counted); err != nil {
			return err
		}
		charge := size
		if counted {
			charge = 0
		}
		tag, err := tx.Exec(ctx, `UPDATE tenants SET reserved_bytes=reserved_bytes-$2+$3 WHERE id=$1 AND tenant_usage()+reserved_bytes-$2+$3<=quota_bytes`, t.Tenant, reserved, charge)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return domain.ErrQuota
		}
		if _, err = tx.Exec(ctx, `UPDATE objects SET state='garbage' WHERE id=(SELECT object_id FROM assets WHERE id=$1) AND state='pending'`, t.ID); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `UPDATE assets SET state='ready',blob_id=$2,reserved_bytes=$3,object_id=NULL WHERE id=$1`, t.ID, bid, charge); err != nil {
			return err
		}
		hit = true
		return s.Enqueue(ctx, tx, t.Tenant, cid, "finalize")
	})
	return hit, err
}
