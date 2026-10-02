package app

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"monitor/internal/domain"
	"monitor/internal/store"
)

const maxRefreshBatch = 500

type RefreshBatch struct {
	ID         string `json:"id"`
	State      string `json:"state"`
	Error      string `json:"error,omitempty"`
	UpdateMode string `json:"update_mode"`
	Total      int    `json:"total"`
	// Submitted counts collections handed to capture, including reused ones.
	Submitted int `json:"submitted"`
	Reused    int `json:"reused"`
	Rejected  int `json:"rejected"`
	// Running and the terminal counts cover the captures that submissions started.
	Running  int `json:"running"`
	Complete int `json:"complete"`
	Partial  int `json:"partial"`
	Failed   int `json:"failed"`
}

// StartRefreshBatch queues refreshes of the tenant's saved collections. Submission
// runs in the background so the capture rate limit delays it instead of failing it.
func (s *Service) StartRefreshBatch(ctx context.Context, tenant string, ids []string, mode string) (out RefreshBatch, err error) {
	if mode == "" {
		mode = "full"
	}
	if mode != "full" && mode != "append" {
		return out, domain.ErrUnsupported
	}
	seen := map[string]bool{}
	unique := make([]string, 0, len(ids))
	for _, id := range ids {
		parsed, e := uuid.Parse(id)
		if e != nil {
			return out, domain.ErrUnsupported
		}
		if id = parsed.String(); !seen[id] {
			seen[id] = true
			unique = append(unique, id)
		}
	}
	if len(unique) == 0 || len(unique) > maxRefreshBatch {
		return out, domain.ErrUnsupported
	}
	err = s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		var saved int
		if e := tx.QueryRow(ctx, `SELECT count(*) FROM tenant_collections WHERE collection_id=ANY($1::uuid[])`, unique).Scan(&saved); e != nil {
			return e
		}
		if saved != len(unique) {
			return domain.ErrNotFound
		}
		var id string
		if e := tx.QueryRow(ctx, `INSERT INTO refresh_batches(tenant_id,collection_ids,update_mode) VALUES($1,$2::uuid[],$3) RETURNING id`, tenant, unique, mode).Scan(&id); e != nil {
			return e
		}
		if e := s.Enqueue(ctx, tx, tenant, id, "refresh_batch"); e != nil {
			return e
		}
		return scanRefreshBatch(ctx, tx, id, &out)
	})
	return
}

func (s *Service) RefreshBatch(ctx context.Context, tenant, id string) (out RefreshBatch, err error) {
	err = s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error { return scanRefreshBatch(ctx, tx, id, &out) })
	return
}

func scanRefreshBatch(ctx context.Context, tx pgx.Tx, id string, b *RefreshBatch) error {
	return tx.QueryRow(ctx, `SELECT b.id,b.state,b.error,b.update_mode,cardinality(b.collection_ids),b.position,b.reused,b.rejected,
		count(c.id) FILTER (WHERE c.state IN ('queued','downloading')),
		count(c.id) FILTER (WHERE c.state='complete'),
		count(c.id) FILTER (WHERE c.state='partial'),
		count(c.id) FILTER (WHERE c.state='failed')
		FROM refresh_batches b LEFT JOIN captures c ON c.id=ANY(b.capture_ids) WHERE b.id=$1 GROUP BY b.id`, id).
		Scan(&b.ID, &b.State, &b.Error, &b.UpdateMode, &b.Total, &b.Submitted, &b.Reused, &b.Rejected, &b.Running, &b.Complete, &b.Partial, &b.Failed)
}

// refreshBatch submits the remaining collections in order, persisting progress
// after each one so retries and snoozes never submit a collection twice.
func (s *Service) refreshBatch(ctx context.Context, task store.Task) error {
	var ids []string
	var mode, state string
	var position int
	var expired bool
	if err := s.DB.Tx(ctx, task.Tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT collection_ids::text[],update_mode,position,state,created_at<now()-interval '1 day' FROM refresh_batches WHERE id=$1`, task.ID).Scan(&ids, &mode, &position, &state, &expired)
	}); err != nil {
		if errors.Is(err, domain.ErrNotFound) {
			return nil
		}
		return err
	}
	if state != "running" {
		return nil
	}
	if expired {
		// Waiting on an unavailable adapter must not keep a batch running forever.
		return s.failRefreshBatch(ctx, task, "capture service unavailable")
	}
	for ; position < len(ids); position++ {
		id := ids[position]
		available, err := s.CaptureAvailable(ctx, task.Tenant, id)
		rejected := errors.Is(err, domain.ErrNotFound)
		if err != nil && !rejected {
			return err
		}
		if !rejected && !available {
			return river.JobSnooze(time.Minute)
		}
		var job domain.Job
		if !rejected {
			job, err = s.Submit(ctx, task.Tenant, domain.CaptureInput{RefreshID: id, UpdateMode: mode, Key: fmt.Sprintf("refresh-batch:%s:%d", task.ID, position)})
			switch {
			case errors.Is(err, domain.ErrRate):
				return river.JobSnooze(time.Minute)
			case errors.Is(err, domain.ErrQuota):
				return s.failRefreshBatch(ctx, task, "storage quota exceeded")
			case errors.Is(err, domain.ErrNotFound), errors.Is(err, domain.ErrUnsupported), errors.Is(err, ErrConnection):
				// This collection cannot be refreshed; the rest of the batch still can.
				rejected = true
			case err != nil:
				return err
			}
		}
		if err = s.DB.Tx(ctx, task.Tenant, func(tx pgx.Tx) error {
			if rejected {
				_, e := tx.Exec(ctx, `UPDATE refresh_batches SET position=$2+1,rejected=rejected+1 WHERE id=$1 AND position=$2`, task.ID, position)
				return e
			}
			// A submission answered by an already finished capture fetched nothing new.
			reused := 0
			if job.State != "queued" && job.State != "downloading" {
				reused = 1
			}
			_, e := tx.Exec(ctx, `UPDATE refresh_batches SET position=$2+1,reused=reused+$3,capture_ids=array_append(capture_ids,$4::uuid) WHERE id=$1 AND position=$2`, task.ID, position, reused, job.ID)
			return e
		}); err != nil {
			return err
		}
	}
	return s.DB.Tx(ctx, task.Tenant, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `UPDATE refresh_batches SET state='complete' WHERE id=$1 AND state='running'`, task.ID)
		return e
	})
}

func (s *Service) failRefreshBatch(ctx context.Context, task store.Task, msg string) error {
	return s.DB.Tx(ctx, task.Tenant, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `UPDATE refresh_batches SET state='failed',error=$2 WHERE id=$1 AND state='running'`, task.ID, msg)
		return e
	})
}
