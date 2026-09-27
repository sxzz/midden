package app

import (
	"context"

	"github.com/jackc/pgx/v5"

	"monitor/internal/domain"
)

// Resolve the final content identity before creating any resources. Account captures
// start private, and only the trusted adapter can classify their result as public.
func (s *Service) resolveCaptureScope(ctx context.Context, tx pgx.Tx, tenant, cid, visibility string) error {
	var old, external, url, provider, connection, savedSource, platform, kind, objectScope string
	if e := tx.QueryRow(ctx, `SELECT a.id,a.external_id,a.url,c.provider_id,coalesce(c.connection_id::text,''),coalesce(c.refresh_from::text,a.id::text),a.platform,a.kind,a.object_scope FROM captures c JOIN archives a ON a.id=c.archive_id WHERE c.id=$1`, cid).Scan(&old, &external, &url, &provider, &connection, &savedSource, &platform, &kind, &objectScope); e != nil {
		return e
	}
	scope := "public"
	dataScope := "00000000-0000-0000-0000-000000000000"
	if visibility == "private" {
		dataScope = tenant
		if connection != "" {
			scope = "connection:" + connection
		}
	}
	if _, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,1))`, dataScope+"|"+platform+"|"+scope+"|"+kind+"|"+objectScope+"|"+external); e != nil {
		return e
	}
	var target string
	e := tx.QueryRow(ctx, `INSERT INTO archives(tenant_id,visibility,external_id,url,provider_id,scope,platform,kind,object_scope) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(data_scope,platform,scope,kind,object_scope,external_id) DO UPDATE SET unreferenced_at=archives.unreferenced_at RETURNING id`, tenant, visibility, external, url, provider, scope, platform, kind, objectScope).Scan(&target)
	if e != nil {
		return e
	}
	// A queued capture has no resources/revisions, so changing its scope here cannot expose old content.
	if _, e = tx.Exec(ctx, `UPDATE captures SET archive_id=$2,visibility=$3 WHERE id=$1`, cid, target, visibility); e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, `INSERT INTO tenant_archives(tenant_id,archive_id,provider_id,connection_id,adapter_id) SELECT $1,$2,$3,nullif($4,'')::uuid,(SELECT adapter_id FROM captures WHERE id=$6) WHERE EXISTS(SELECT FROM tenant_archives WHERE archive_id=$5) ON CONFLICT(tenant_id,archive_id) DO UPDATE SET provider_id=excluded.provider_id,connection_id=excluded.connection_id,adapter_id=excluded.adapter_id`, tenant, target, provider, connection, savedSource, cid); e != nil {
		return e
	}
	var within bool
	if e = tx.QueryRow(ctx, `SELECT tenant_usage()+reserved_bytes<=quota_bytes FROM tenants WHERE id=$1`, tenant).Scan(&within); e != nil {
		return e
	}
	if !within {
		return domain.ErrQuota
	}
	// Keep an old completed archive until successful finalization; remove only empty staging references.
	if target != old {
		if _, e = tx.Exec(ctx, `DELETE FROM tenant_archives WHERE archive_id=$1 AND EXISTS(SELECT FROM archives WHERE id=$1 AND current_revision IS NULL)`, old); e != nil {
			return e
		}
		_, e = tx.Exec(ctx, `SELECT mark_unreferenced($1)`, old)
	}
	if e != nil {
		return e
	}
	if _, e = tx.Exec(ctx, `UPDATE archives SET unreferenced_at=NULL WHERE id=$1 AND EXISTS(SELECT FROM tenant_archives WHERE archive_id=$1)`, target); e != nil {
		return e
	}
	_, e = tx.Exec(ctx, `SELECT mark_unreferenced($1)`, target)
	return e
}
