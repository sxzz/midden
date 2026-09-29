package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	pb "monitor/api/adapter/v1"
	"monitor/internal/adapter"
	"monitor/internal/domain"
	"monitor/internal/store"
)

func validateRelatedResult(policy *pb.Provider, r *pb.FetchResponse, platform, kind, scope string) error {
	if len(r.NextPageCursor) > 4096 || r.MaxBatchSize > 1000 || ((r.NextPageCursor != "" || r.MaxBatchSize > 0) && !adapter.Supports(policy, adapter.CapturePage, 1, 0)) {
		return &PermanentError{"undeclared or invalid page continuation"}
	}
	if c := r.CanonicalTarget; c != nil {
		if !adapter.Supports(policy, adapter.CaptureCanonical, 1, 0) || c.Platform != platform || c.Kind != kind || c.ObjectScope != scope || c.ExternalId == "" || domain.ValidateURL(c.Url) != nil {
			return &PermanentError{"invalid canonical target"}
		}
	}
	if len(r.RelatedTargets) > 0 && !adapter.Supports(policy, adapter.CaptureRelated, 1, 0) {
		return &PermanentError{"undeclared related capture capability"}
	}
	// Bounded fanout for any adapter; never silently truncate an upstream page.
	if len(r.RelatedTargets) > 200 {
		return &PermanentError{"related capture page exceeds 200 targets"}
	}
	for _, t := range r.RelatedTargets {
		if t == nil || domain.ValidateURL(t.Url) != nil {
			return &PermanentError{"invalid related target"}
		}
	}
	return nil
}

// Each submission executes under its own tenant and original provider selection.
// Child submissions do not expand again and do not send unsolicited channel messages.
func (s *Service) related(ctx context.Context, task store.Task) error {
	var state, parent, provider, connection, adapterID, parentURL string
	var automatic, stopped bool
	var raw []byte
	err := s.DB.Tx(ctx, task.Tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT s.related_state,c.state,s.related_provider,coalesce(s.related_connection::text,''),s.related_adapter,c.related_targets,c.automatic,a.url,s.collection_stopped FROM submissions s JOIN captures c ON c.id=s.capture_id JOIN archives a ON a.id=c.archive_id WHERE s.id=$1`, task.ID).Scan(&state, &parent, &provider, &connection, &adapterID, &raw, &automatic, &parentURL, &stopped)
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if state != "pending" || stopped {
		return nil
	}
	if parent == "queued" || parent == "downloading" {
		return river.JobSnooze(2 * time.Second)
	}
	if parent == "failed" {
		return s.fail(ctx, task, "parent capture failed")
	}
	// Canonicalization can move a shared capture away from its provisional URL identity.
	// Repair only this submitter's reference, never another tenant's account selection.
	err = s.DB.Tx(ctx, task.Tenant, func(tx pgx.Tx) error {
		if err := lockTenant(ctx, tx, task.Tenant); err != nil {
			return err
		}
		var source, archive string
		if err := tx.QueryRow(ctx, `SELECT s.related_source_archive,c.archive_id FROM submissions s JOIN captures c ON c.id=s.capture_id WHERE s.id=$1`, task.ID).Scan(&source, &archive); err != nil {
			return err
		}
		var held bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT FROM tenant_archives WHERE archive_id IN($1,$2))`, source, archive).Scan(&held); err != nil {
			return err
		}
		if !held {
			return domain.ErrNotFound
		}
		if source == archive {
			return nil
		}
		if _, err := tx.Exec(ctx, `INSERT INTO tenant_archives(tenant_id,archive_id,provider_id,connection_id,adapter_id) VALUES($1,$2,$3,nullif($4,'')::uuid,$5) ON CONFLICT DO NOTHING`, task.Tenant, archive, provider, connection, adapterID); err != nil {
			return err
		}
		var within bool
		if err := tx.QueryRow(ctx, `SELECT tenant_unlimited() OR tenant_usage()+reserved_bytes<=quota_bytes FROM tenants WHERE id=$1`, task.Tenant).Scan(&within); err != nil {
			return err
		}
		if !within {
			return domain.ErrQuota
		}
		if _, err := tx.Exec(ctx, `DELETE FROM tenant_archives WHERE archive_id=$1 AND EXISTS(SELECT FROM archives WHERE id=$1 AND current_revision IS NULL)`, source); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `SELECT mark_unreferenced($1)`, source)
		return err
	})
	if err != nil {
		return err
	}
	var targets []*pb.RelatedTarget
	if err = json.Unmarshal(raw, &targets); err != nil {
		return err
	}
	scoped := s
	if len(s.Adapters) > 0 {
		scoped, err = s.forAdapter(adapterID)
		if err != nil {
			return err
		}
	}
	if automatic {
		target, err := scoped.Resolve(ctx, parentURL)
		if err != nil {
			return err
		}
		if target.RefreshOnSubmit {
			// An explicit request joining an automatic capture still needs collection expansion.
			_, err = scoped.Submit(ctx, task.Tenant, domain.CaptureInput{ParentSubmission: task.ID, URL: parentURL, ProviderID: provider, ConnectionID: connection, Key: "related-expand:" + task.ID})
			if errors.Is(err, errCollectionStopped) {
				return nil
			}
			if errors.Is(err, domain.ErrRate) {
				return river.JobSnooze(time.Minute)
			}
			if err != nil {
				return err
			}
			targets = nil
		}
	}
	for i, target := range targets {
		_, err = scoped.Submit(ctx, task.Tenant, domain.CaptureInput{ParentSubmission: task.ID, URL: target.Url, ProviderID: provider, ConnectionID: connection, Automatic: true, RefreshAfterSeconds: target.RefreshAfterSeconds, Key: fmt.Sprintf("related:%s:%d", task.ID, i)})
		if errors.Is(err, errCollectionStopped) {
			return nil
		}
		if errors.Is(err, domain.ErrRate) {
			return river.JobSnooze(time.Minute)
		}
		if err != nil {
			return err
		}
	}

	var limit uint32
	var next string
	if err := s.DB.Tx(ctx, task.Tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT s.collection_limit,c.next_page_cursor FROM submissions s JOIN captures c ON c.id=s.capture_id WHERE s.id=$1`, task.ID).Scan(&limit, &next)
	}); err != nil {
		return err
	}
	if limit > uint32(len(targets)) && len(targets) > 0 && next != "" {
		remaining := limit - uint32(len(targets))
		_, err := scoped.Submit(ctx, task.Tenant, domain.CaptureInput{ParentSubmission: task.ID, URL: parentURL, ProviderID: provider, ConnectionID: connection, PageCursor: next, PageSize: remaining, CollectionLimit: remaining, Key: "batch:" + task.ID})
		if errors.Is(err, errCollectionStopped) {
			return nil
		}
		if errors.Is(err, domain.ErrRate) {
			return river.JobSnooze(time.Minute)
		}
		if err != nil {
			return err
		}
		if err = s.DB.Tx(ctx, task.Tenant, func(tx pgx.Tx) error {
			_, e := tx.Exec(ctx, `UPDATE submissions SET next_submission=(SELECT id FROM submissions WHERE idem_key=$2) WHERE id=$1`, task.ID, "batch:"+task.ID)
			return e
		}); err != nil {
			return err
		}
	}
	return s.DB.Tx(ctx, task.Tenant, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE submissions SET related_state='complete' WHERE id=$1 AND NOT collection_stopped`, task.ID)
		return err
	})
}
