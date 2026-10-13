package app

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	pb "monitor/api/adapter/v1"
	"monitor/internal/domain"
)

// Resolve the adapter's canonical identity before creating any resources.
// Content is stored once per identity, so only canonical moves change the collection.
func (s *Service) resolveCaptureScope(ctx context.Context, tx pgx.Tx, tenant, cid string, canonical *pb.ResolveResponse) error {
	var old, external, provider, connection, savedSource, platform, kind, objectScope string
	if e := tx.QueryRow(ctx, `SELECT a.id,a.external_id,c.provider_id,coalesce(c.connection_id::text,''),coalesce(c.refresh_from::text,a.id::text),a.platform,a.kind,a.object_scope FROM captures c JOIN collections a ON a.id=c.collection_id WHERE c.id=$1`, cid).Scan(&old, &external, &provider, &connection, &savedSource, &platform, &kind, &objectScope); e != nil {
		return e
	}
	if canonical == nil {
		return nil
	}
	if canonical.ExternalId == external {
		_, e := tx.Exec(ctx, `UPDATE collections SET url=$2 WHERE id=$1 AND url<>$2`, old, canonical.Url)
		return e
	}
	requestedExternal := external
	external = canonical.ExternalId
	if _, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,1))`, platform+"|"+kind+"|"+objectScope+"|"+external); e != nil {
		return e
	}
	var target string
	e := tx.QueryRow(ctx, `INSERT INTO collections(external_id,url,provider_id,platform,kind,object_scope) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(platform,kind,object_scope,external_id) DO UPDATE SET unreferenced_at=collections.unreferenced_at RETURNING id`, external, canonical.Url, provider, platform, kind, objectScope).Scan(&target)
	if e != nil {
		return e
	}
	// Preserve the adapter's alias without rewriting historical entity snapshots.
	if _, e = tx.Exec(ctx, `INSERT INTO collection_identity_aliases(platform,kind,object_scope,external_id,collection_id) VALUES($1,$2,$3,$4,$5)
 ON CONFLICT(platform,kind,object_scope,external_id) DO UPDATE SET collection_id=excluded.collection_id`, platform, kind, objectScope, requestedExternal, target); e != nil {
		return e
	}
	joined, e := s.joinActiveCapture(ctx, tx, tenant, cid, target)
	if e != nil {
		return e
	}
	// A queued capture has no resources/revisions, so moving it cannot expose old content.
	if !joined {
		if _, e = tx.Exec(ctx, `UPDATE captures SET collection_id=$2 WHERE id=$1`, cid, target); e != nil {
			return e
		}
	}
	if _, e = tx.Exec(ctx, `INSERT INTO tenant_collections(tenant_id,collection_id,provider_id,connection_id,adapter_id) SELECT $1,$2,$3,nullif($4,'')::uuid,(SELECT adapter_id FROM captures WHERE id=$6) WHERE EXISTS(SELECT FROM tenant_collections WHERE collection_id=$5) ON CONFLICT(tenant_id,collection_id) DO UPDATE SET provider_id=excluded.provider_id,connection_id=excluded.connection_id,adapter_id=excluded.adapter_id`, tenant, target, provider, connection, savedSource, cid); e != nil {
		return e
	}
	var within bool
	if e = tx.QueryRow(ctx, `SELECT tenant_unlimited() OR tenant_usage()+reserved_bytes<=quota_bytes FROM tenants WHERE id=$1`, tenant).Scan(&within); e != nil {
		return e
	}
	if !within {
		return domain.ErrQuota
	}
	// Keep an old completed collection; remove only empty staging references.
	if _, e = tx.Exec(ctx, `DELETE FROM tenant_collections WHERE collection_id=$1 AND EXISTS(SELECT FROM collections WHERE id=$1 AND current_revision IS NULL)`, old); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, `SELECT mark_unreferenced($1)`, old); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, `UPDATE collections SET unreferenced_at=NULL WHERE id=$1 AND EXISTS(SELECT FROM tenant_collections WHERE collection_id=$1)`, target); e != nil {
		return e
	}
	_, e = tx.Exec(ctx, `SELECT mark_unreferenced($1)`, target)
	return e
}

// joinActiveCapture ends a queued capture whose canonical collection already
// has the same capture running, and hands its submissions to that one. Two
// provisional identities (such as an old and a new handle) can turn out to be
// one object while both are fetched, and one_active_capture allows a single
// active capture there, so this one cannot move.
//
// The caller holds the target collection's row, which a capture needs to
// finish, so the running one cannot end before the submissions reach it.
func (s *Service) joinActiveCapture(ctx context.Context, tx pgx.Tx, tenant, cid, target string) (bool, error) {
	var running string
	e := tx.QueryRow(ctx, `SELECT o.id FROM captures c JOIN captures o ON o.collection_id=$2 AND o.id<>c.id AND o.adapter_id=c.adapter_id AND o.provider_id=c.provider_id
 AND coalesce(o.connection_id,CASE WHEN o.visibility='public' THEN '00000000-0000-0000-0000-000000000000'::uuid ELSE o.tenant_id END)=coalesce(c.connection_id,CASE WHEN c.visibility='public' THEN '00000000-0000-0000-0000-000000000000'::uuid ELSE c.tenant_id END)
 AND o.page_cursor=c.page_cursor AND o.page_size=c.page_size AND o.automatic=c.automatic AND o.mode=c.mode AND o.state IN('queued','downloading') WHERE c.id=$1`, cid, target).Scan(&running)
	if errors.Is(e, pgx.ErrNoRows) {
		return false, nil
	}
	if e != nil {
		return false, e
	}
	if _, e = tx.Exec(ctx, `UPDATE submissions SET capture_id=$2 WHERE capture_id=$1`, cid, running); e != nil {
		return false, e
	}
	if _, e = tx.Exec(ctx, `UPDATE refresh_batches SET capture_ids=array_replace(capture_ids,$1::uuid,$2::uuid) WHERE $1::uuid=ANY(capture_ids)`, cid, running); e != nil {
		return false, e
	}
	return true, s.failCaptureTx(ctx, tx, tenant, cid, "joined a running capture of the same content")
}
