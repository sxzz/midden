package app

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	pb "monitor/api/adapter/v1"
	"monitor/internal/adapter"
	"monitor/internal/store"
)

// objectRef is an adapter object identity, the unit of access grants.
type objectRef struct {
	Platform    string `json:"platform"`
	Kind        string `json:"kind"`
	ObjectScope string `json:"object_scope"`
	ExternalID  string `json:"external_id"`
}

func (r objectRef) proto() *pb.ObjectRef {
	return &pb.ObjectRef{Platform: r.Platform, Kind: r.Kind, ObjectScope: r.ObjectScope, ExternalId: r.ExternalID}
}

func objectRefs(in []*pb.ObjectRef) []objectRef {
	out := []objectRef{}
	seen := map[objectRef]bool{}
	for _, v := range in {
		if v == nil || v.Platform == "" || v.Kind == "" || v.ExternalId == "" || len(v.ExternalId) > 200 {
			continue
		}
		r := objectRef{v.Platform, v.Kind, v.ObjectScope, v.ExternalId}
		if !seen[r] && len(out) < 64 {
			seen[r] = true
			out = append(out, r)
		}
	}
	return out
}

// grantAccess records that one of the tenant's accounts could read these objects.
// A later success restores access that a failed check had revoked.
func grantAccess(ctx context.Context, tx pgx.Tx, tenant, connection, method string, refs []objectRef) error {
	for _, r := range refs {
		if _, e := tx.Exec(ctx, `INSERT INTO access_grants(tenant_id,platform,kind,object_scope,external_id,connection_id,method) VALUES($1,$2,$3,$4,$5,nullif($6,'')::uuid,$7) ON CONFLICT(tenant_id,platform,kind,object_scope,external_id) DO UPDATE SET verified_at=now(),revoked_at=NULL,connection_id=excluded.connection_id,method=excluded.method`, tenant, r.Platform, r.Kind, r.ObjectScope, r.ExternalID, connection, method); e != nil {
			return e
		}
	}
	return nil
}

// revokeAccess hides versions observed after now; earlier versions stay readable.
func (s *Service) revokeAccess(ctx context.Context, tenant string, r objectRef) error {
	return s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `UPDATE access_grants SET revoked_at=now() WHERE tenant_id=$1 AND (platform,kind,object_scope,external_id)=($2,$3,$4,$5) AND revoked_at IS NULL`, tenant, r.Platform, r.Kind, r.ObjectScope, r.ExternalID)
		return e
	})
}

func accessDenied(e error) bool {
	c := status.Code(e)
	return c == codes.PermissionDenied || c == codes.NotFound
}

// checkAccess proves with the tenant's own account that it can read content
// another source already stored, then reuses that content without fetching it.
func (s *Service) checkAccess(ctx context.Context, t store.Task, collection, url string, target *pb.ObjectRef, provider, connection, scope string, credential *pb.Credential, revision int64) error {
	if _, err := s.requireProvider(ctx, provider, adapter.CaptureAccess); err != nil {
		return s.fetchInstead(ctx, t)
	}
	var embedded []*pb.ObjectRef
	err := s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx, `SELECT platform,kind,object_scope,external_id FROM access_requirements($1) LIMIT 64`, collection)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var r objectRef
			if e = rows.Scan(&r.Platform, &r.Kind, &r.ObjectScope, &r.ExternalID); e != nil {
				return e
			}
			embedded = append(embedded, r.proto())
		}
		return rows.Err()
	})
	if err != nil {
		return err
	}
	callCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	var trailer metadata.MD
	started := time.Now()
	r, e := s.Adapter.CheckAccess(callCtx, &pb.CheckAccessRequest{Url: url, Target: target, Embedded: embedded, ProviderId: provider, ConnectionId: connection, AccessScope: scope, RequestId: t.ID, Credential: credential}, grpc.Trailer(&trailer))
	ProviderDuration.WithLabelValues(provider).Observe(time.Since(started).Seconds())
	ProviderResults.WithLabelValues(provider, status.Code(e).String()).Inc()
	root := objectRef{target.Platform, target.Kind, target.ObjectScope, target.ExternalId}
	if e != nil {
		switch {
		case status.Code(e) == codes.Unauthenticated:
			s.markReauth(ctx, t.Tenant, connection, revision)
		case status.Code(e) == codes.InvalidArgument || status.Code(e) == codes.Unimplemented:
			// The adapter cannot check this kind of object; observe it instead.
			return s.fetchInstead(ctx, t)
		case accessDenied(e):
			if err := s.revokeAccess(ctx, t.Tenant, root); err != nil {
				return err
			}
		}
		if values := trailer.Get("retry-after"); len(values) > 0 {
			if n, _ := strconv.Atoi(values[0]); n > 0 && n <= 86400 {
				return &RetryError{After: time.Duration(n) * time.Second, Err: e}
			}
		}
		return e
	}
	allowed := map[objectRef]bool{root: true}
	for _, v := range objectRefs(embedded) {
		allowed[v] = true
	}
	accessible := objectRefs(r.Accessible)
	hasRoot := false
	for _, v := range accessible {
		if !allowed[v] {
			return &PermanentError{"adapter granted an object that was not requested"}
		}
		hasRoot = hasRoot || v == root
	}
	if !hasRoot {
		return &PermanentError{"adapter did not confirm access to the target"}
	}
	visibility := "private"
	if r.Visibility == pb.Visibility_VISIBILITY_PUBLIC {
		visibility = "public"
	}
	return s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
		if e := lockTenant(ctx, tx, t.Tenant); e != nil {
			return e
		}
		if e := lockCaptureCollection(ctx, tx, t.ID); e != nil {
			return e
		}
		var state string
		if e := tx.QueryRow(ctx, `SELECT state FROM captures WHERE id=$1 FOR UPDATE`, t.ID).Scan(&state); e != nil {
			return e
		}
		if state != "queued" {
			return nil
		}
		if e := validateExecution(ctx, tx, connection, revision); e != nil {
			return e
		}
		if e := grantAccess(ctx, tx, t.Tenant, connection, "check", accessible); e != nil {
			return e
		}
		var head *string
		if e := tx.QueryRow(ctx, `SELECT visible_head($1)`, collection).Scan(&head); e != nil {
			return e
		}
		if head == nil {
			// Embedded restrictions can still hide every stored version.
			return s.failCaptureTx(ctx, tx, t.Tenant, t.ID, "no stored version is accessible to this account")
		}
		if _, e := tx.Exec(ctx, `UPDATE captures SET state='complete',visibility=$2,revision_id=$3,credential_revision=$4,finished_at=now() WHERE id=$1`, t.ID, visibility, *head, revision); e != nil {
			return e
		}
		return s.deliveries(ctx, tx, t.Tenant, t.ID)
	})
}

// fetchInstead turns a queued check into a full observation by the same account.
func (s *Service) fetchInstead(ctx context.Context, t store.Task) error {
	err := s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
		tag, e := tx.Exec(ctx, `UPDATE captures SET mode='fetch' WHERE id=$1 AND state='queued' AND mode='check'`, t.ID)
		if e != nil || tag.RowsAffected() == 0 {
			return e
		}
		return s.Enqueue(ctx, tx, t.Tenant, t.ID, "capture")
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	return err
}
