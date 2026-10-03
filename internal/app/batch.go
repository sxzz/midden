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

// RefreshBatch is shared with channels, which report its progress.
type RefreshBatch = domain.RefreshBatch

// StartRefreshBatch queues refreshes of the tenant's saved collections. Submission
// runs in the background so the capture rate limit delays it instead of failing it.
// With a channel, the tenant's private chat there gets one progress message.
func (s *Service) StartRefreshBatch(ctx context.Context, tenant string, ids []string, mode, channel string) (out RefreshBatch, err error) {
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
		var chat *string
		if channel != "" {
			e := tx.QueryRow(ctx, `SELECT external_id FROM identities WHERE tenant_id=$1 AND channel_id=$2 LIMIT 1`, tenant, channel).Scan(&chat)
			if e != nil && !errors.Is(e, pgx.ErrNoRows) {
				return e
			}
		}
		var id string
		if e := tx.QueryRow(ctx, `INSERT INTO refresh_batches(tenant_id,collection_ids,update_mode,channel_id,chat_id) VALUES($1,$2::uuid[],$3,CASE WHEN $5::text IS NOT NULL THEN nullif($4,'')::uuid END,$5) RETURNING id`, tenant, unique, mode, channel, chat).Scan(&id); e != nil {
			return e
		}
		if e := s.Enqueue(ctx, tx, tenant, id, "refresh_batch"); e != nil {
			return e
		}
		if chat != nil {
			if _, e := tx.Exec(ctx, `INSERT INTO channel_work(tenant_id,channel_id,kind,resource) VALUES($1,$2,'batch',$3)`, tenant, channel, id); e != nil {
				return e
			}
		}
		return scanRefreshBatch(ctx, tx, id, &out)
	})
	return
}

func (s *Service) RefreshBatch(ctx context.Context, tenant, id string) (out RefreshBatch, err error) {
	err = s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error { return scanRefreshBatch(ctx, tx, id, &out) })
	return
}

// Members are followed from each submitted collection through its continuation
// pages, matching how collection progress is reported to channels. Their total
// counts the targets a fetched listing named, so it is known while the listing
// still downloads and before its members are submitted.
//
// Roots and members are looked up per row through their indexes (the exact
// idempotency key, parent_submission). Matching either by a key prefix read
// every submission of the tenant on each poll.
func scanRefreshBatch(ctx context.Context, tx pgx.Tx, id string, b *RefreshBatch) error {
	var membersPending bool
	err := tx.QueryRow(ctx, `WITH RECURSIVE batch AS (SELECT * FROM refresh_batches WHERE id=$1),
pages AS (
 SELECT s.id,s.capture_id,s.next_submission,s.related_state,0 AS depth FROM batch CROSS JOIN LATERAL unnest(batch.collection_ids) WITH ORDINALITY n(id,position) CROSS JOIN LATERAL (SELECT root.* FROM submissions root WHERE root.tenant_id=batch.tenant_id AND root.idem_key='refresh-batch:'||batch.id::text||':'||(n.position-1) OFFSET 0) s JOIN captures c ON c.id=s.capture_id WHERE c.is_collection
 UNION ALL SELECT s.id,s.capture_id,s.next_submission,s.related_state,p.depth+1 FROM submissions s JOIN pages p ON s.id=p.next_submission WHERE p.depth<1000
), members AS (SELECT DISTINCT child.capture_id FROM pages CROSS JOIN LATERAL (SELECT member.capture_id FROM submissions member WHERE member.parent_submission=pages.id AND member.idem_key LIKE 'related:%' OFFSET 0) child)
SELECT batch.id,batch.state,batch.error,batch.update_mode,cardinality(batch.collection_ids),batch.position,batch.reused,batch.rejected,
 (SELECT count(*) FROM captures c WHERE c.id=ANY(batch.capture_ids) AND c.state IN ('queued','downloading')),
 (SELECT count(*) FROM captures c WHERE c.id=ANY(batch.capture_ids) AND c.state='complete'),
 (SELECT count(*) FROM captures c WHERE c.id=ANY(batch.capture_ids) AND c.state='partial'),
 (SELECT count(*) FROM captures c WHERE c.id=ANY(batch.capture_ids) AND c.state='failed'),
 GREATEST((SELECT count(*) FROM members),(SELECT count(DISTINCT t->>'url') FROM pages JOIN captures c ON c.id=pages.capture_id CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.related_targets)='array' THEN c.related_targets ELSE '[]' END) t)),
 (SELECT count(*) FROM members JOIN captures c ON c.id=members.capture_id WHERE c.state='complete'),
 (SELECT count(*) FROM members JOIN captures c ON c.id=members.capture_id WHERE c.state='partial'),
 (SELECT count(*) FROM members JOIN captures c ON c.id=members.capture_id WHERE c.state='failed'),
 (SELECT count(*) FROM members JOIN captures c ON c.id=members.capture_id WHERE c.state IN ('queued','downloading')),
 EXISTS(SELECT FROM pages WHERE related_state='pending')
FROM batch`, id).Scan(&b.ID, &b.State, &b.Error, &b.UpdateMode, &b.Total, &b.Submitted, &b.Reused, &b.Rejected, &b.Running, &b.Complete, &b.Partial, &b.Failed,
		&b.Members.Total, &b.Members.Complete, &b.Members.Partial, &b.Members.Failed, &b.Members.Pending, &membersPending)
	if err != nil {
		return err
	}
	b.Members.Done = !membersPending && b.Members.Pending == 0
	// A failed batch submits nothing more, but what it started still runs.
	b.Done = b.State != "running" && b.Running == 0 && b.Members.Done
	return scanRefreshItems(ctx, tx, id, b)
}

// scanRefreshItems lists the submitted collections still running or waiting
// on their members, so a profile reports its posts while it is being updated.
func scanRefreshItems(ctx context.Context, tx pgx.Tx, id string, b *RefreshBatch) error {
	rows, err := tx.Query(ctx, `WITH RECURSIVE pages AS (
 SELECT s.id AS root,s.id,s.capture_id,s.next_submission,s.related_state,0 AS depth FROM refresh_batches b CROSS JOIN LATERAL unnest(b.collection_ids) WITH ORDINALITY n(id,position) CROSS JOIN LATERAL (SELECT root.* FROM submissions root WHERE root.tenant_id=b.tenant_id AND root.idem_key='refresh-batch:'||b.id::text||':'||(n.position-1) OFFSET 0) s WHERE b.id=$1
 UNION ALL SELECT p.root,s.id,s.capture_id,s.next_submission,s.related_state,p.depth+1 FROM submissions s JOIN pages p ON s.id=p.next_submission WHERE p.depth<1000
), members AS (SELECT DISTINCT pages.root,child.capture_id FROM pages CROSS JOIN LATERAL (SELECT member.capture_id FROM submissions member WHERE member.parent_submission=pages.id AND member.idem_key LIKE 'related:%' OFFSET 0) child),
targets AS (SELECT pages.root,count(DISTINCT t->>'url') AS n FROM pages JOIN captures c ON c.id=pages.capture_id CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.related_targets)='array' THEN c.related_targets ELSE '[]' END) t GROUP BY pages.root),
progress AS (SELECT members.root,count(*) AS total,
 count(*) FILTER (WHERE c.state='complete') AS complete,
 count(*) FILTER (WHERE c.state='partial') AS partial,
 count(*) FILTER (WHERE c.state='failed') AS failed,
 count(*) FILTER (WHERE c.state IN ('queued','downloading')) AS pending
 FROM members JOIN captures c ON c.id=members.capture_id GROUP BY members.root)
SELECT a.url,c.collection_id,c.state IN ('queued','downloading'),GREATEST(coalesce(t.n,0),coalesce(p.total,0)),coalesce(p.complete,0),coalesce(p.partial,0),coalesce(p.failed,0),coalesce(p.pending,0),
 EXISTS(SELECT FROM pages x WHERE x.root=r.id AND x.related_state='pending')
FROM pages r JOIN submissions s ON s.id=r.id JOIN captures c ON c.id=r.capture_id JOIN collections a ON a.id=c.collection_id
LEFT JOIN targets t ON t.root=r.id LEFT JOIN progress p ON p.root=r.id
WHERE r.depth=0 ORDER BY s.created_at,s.id`, id)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var item domain.RefreshItem
		var membersPending bool
		m := &item.Members
		if err := rows.Scan(&item.URL, &item.CollectionID, &item.Running, &m.Total, &m.Complete, &m.Partial, &m.Failed, &m.Pending, &membersPending); err != nil {
			return err
		}
		m.Done = !membersPending && m.Pending == 0
		if item.Running || !m.Done {
			b.Active = append(b.Active, item)
		}
	}
	if err = rows.Err(); err != nil {
		return err
	}
	rows.Close()
	// Saved content lets channels name an item instead of showing its URL.
	ids := make([]string, len(b.Active))
	for i, item := range b.Active {
		ids[i] = item.CollectionID
	}
	saved, err := collectionsByID(ctx, tx, ids)
	if err != nil {
		return err
	}
	for i, item := range b.Active {
		if a, ok := saved[item.CollectionID]; ok {
			b.Active[i].Collection = &a
		}
	}
	return nil
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
