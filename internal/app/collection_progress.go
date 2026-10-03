package app

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"monitor/internal/domain"
)

const collectionChainSQL = `WITH RECURSIVE pages AS (
 SELECT s.*,0 AS depth FROM submissions s WHERE id=$1
 UNION ALL SELECT s.*,p.depth+1 FROM submissions s JOIN pages p ON s.id=p.next_submission WHERE p.depth<1000
)`

var errCollectionStopped = errors.New("collection stopped")

func (s *Service) StopCollection(ctx context.Context, tenant, id string) error {
	err := s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		if err := lockTenant(ctx, tx, tenant); err != nil {
			return err
		}
		var collection bool
		if err := tx.QueryRow(ctx, `SELECT c.is_collection FROM submissions s JOIN captures c ON c.id=s.capture_id WHERE s.id=$1`, id).Scan(&collection); err != nil {
			return err
		}
		if !collection {
			return domain.ErrUnsupported
		}
		// The tenant lock also guards Submit, so no new descendants can escape this checkpoint.
		_, err := tx.Exec(ctx, `WITH RECURSIVE stopped AS (
            SELECT id,next_submission FROM submissions WHERE id=$1
            UNION SELECT s.id,s.next_submission FROM stopped p CROSS JOIN LATERAL (
                SELECT id,next_submission FROM submissions WHERE parent_submission=p.id
                UNION ALL SELECT id,next_submission FROM submissions WHERE id=p.next_submission
                UNION ALL SELECT id,next_submission FROM submissions WHERE tenant_id=current_tenant() AND idem_key='batch:'||p.id::text
            ) s
        ) UPDATE submissions SET collection_stopped=true,related_state=CASE WHEN related_state='pending' THEN 'complete' ELSE related_state END WHERE id IN(SELECT id FROM stopped)`, id)
		if err != nil {
			return err
		}
		return s.Enqueue(ctx, tx, tenant, id, "status")
	})
	return err
}
