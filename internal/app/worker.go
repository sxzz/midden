package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"sync"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"google.golang.org/genproto/googleapis/rpc/errdetails"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "monitor/api/adapter/v1"
	"monitor/internal/adapter"
	"monitor/internal/domain"
	"monitor/internal/store"
)

type Worker struct {
	river.WorkerDefaults[store.Task]
	S     *Service
	retry sync.Map
}

func (w *Worker) Timeout(*river.Job[store.Task]) time.Duration { return 10 * time.Minute }
func (w *Worker) NextRetry(j *river.Job[store.Task]) time.Time {
	if t, ok := w.retry.LoadAndDelete(j.ID); ok {
		return t.(time.Time)
	}
	return time.Now().Add(time.Duration(1<<min(j.Attempt, 8)) * time.Second)
}

func (w *Worker) Work(ctx context.Context, j *river.Job[store.Task]) error {
	start := time.Now()
	defer func() { TaskDuration.WithLabelValues(j.Args.Type).Observe(time.Since(start).Seconds()) }()
	paused, err := w.S.taskPaused(ctx, j.Args)
	if err != nil {
		return err
	}
	if paused {
		return river.JobSnooze(time.Minute)
	}
	var e error
	switch j.Args.Type {
	case "related":
		e = w.S.related(ctx, j.Args)
	case "capture":
		e = w.S.capture(ctx, j.Args)
	case "download":
		e = w.S.download(ctx, j.Args)
	case "thumbnail":
		e = w.S.thumbnail(ctx, j.Args)
	case "finalize":
		e = w.S.finalize(ctx, j.Args.Tenant, j.Args.ID)
	case "refresh_batch":
		e = w.S.refreshBatch(ctx, j.Args)
	default:
		return river.JobCancel(fmt.Errorf("unknown task type"))
	}
	if e == nil {
		TaskResults.WithLabelValues(j.Args.Type, "success").Inc()
		return nil
	}
	var snooze *river.JobSnoozeError
	if errors.As(e, &snooze) {
		return e
	}
	TaskResults.WithLabelValues(j.Args.Type, "error").Inc()
	fields := []any{"job_id", j.ID, "task_id", j.Args.ID, "task_type", j.Args.Type, "attempt", j.Attempt, "max_attempts", j.MaxAttempts, "elapsed_ms", time.Since(start).Milliseconds(), "retry_after_ms", RetryDelay(e).Milliseconds()}
	slog.WarnContext(ctx, "task execution failed", append(fields, diagnosticError(e)...)...)
	permanent := errors.Is(e, domain.ErrQuota) || errors.Is(e, domain.ErrUnsupported) || errors.Is(e, domain.ErrNotFound) || errors.Is(e, ErrConnection)
	switch status.Code(e) {
	case codes.InvalidArgument, codes.FailedPrecondition, codes.Unimplemented, codes.PermissionDenied, codes.Unauthenticated:
		permanent = true
	}
	var p *PermanentError
	if errors.As(e, &p) {
		permanent = true
	}
	if permanent || j.Attempt >= j.MaxAttempts {
		if err := w.S.fail(ctx, j.Args, safeError(e)); err != nil {
			return err
		}
		return river.JobCancel(fmt.Errorf("%s", safeError(e)))
	}
	if d := RetryDelay(e); d > 0 { // Scheduled retry retains the attempt count (unlike JobSnooze).
		w.retry.Store(j.ID, time.Now().Add(d))
		return &RetryError{After: d, Err: e}
	}
	return fmt.Errorf("%s", safeError(e))
}

// markSourceState records that the source is gone. The capture still fails;
// earlier revisions stay as they were.
func (s *Service) markSourceState(ctx context.Context, tenant, collection, state string) error {
	return s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `UPDATE collections SET source_state=$2,source_state_at=now() WHERE id=$1 AND source_state IS DISTINCT FROM $2`, collection, state)
		return e
	})
}

type PermanentError struct{ Message string }

func (e *PermanentError) Error() string { return e.Message }

type RetryError struct {
	After time.Duration
	Err   error
}

func (e *RetryError) Error() string { return "temporary upstream failure" }
func RetryDelay(e error) time.Duration {
	var r *RetryError
	if errors.As(e, &r) {
		return r.After
	}
	for _, v := range status.Convert(e).Details() {
		if d, ok := v.(*errdetails.RetryInfo); ok {
			return d.RetryDelay.AsDuration()
		}
	}
	return 0
}

func safeError(e error) string {
	if errors.Is(e, ErrConnection) {
		return "账号不可用，请重新授权或使用 /account 选择公共来源。"
	}
	if errors.Is(e, domain.ErrQuota) {
		return "storage quota exceeded"
	}
	if errors.Is(e, domain.ErrUnsupported) {
		return "provider operation unsupported"
	}
	var p *PermanentError
	if errors.As(e, &p) {
		return p.Message
	}
	if s, ok := status.FromError(e); ok {
		return s.Message()
	}
	return "operation failed; retry or inspect service health"
}

// PostgreSQL session locks provide crash-safe tenant slots without a network call in a transaction.
func (s *Service) slot(ctx context.Context, tenant string) (*pgxpool.Conn, int, error) {
	var unlimited bool
	if err := s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, "SELECT tenant_unlimited()").Scan(&unlimited)
	}); err != nil {
		return nil, 0, err
	}
	if unlimited {
		return nil, 0, nil
	}

	c, e := s.DB.Pool.Acquire(ctx)
	if e != nil {
		return nil, 0, e
	}
	for i := 0; i < s.Config.TenantConcurrency; i++ {
		var ok bool
		if e = c.QueryRow(ctx, `SELECT pg_try_advisory_lock(hashtext($1),$2)`, tenant, i).Scan(&ok); e != nil {
			c.Release()
			return nil, 0, e
		}
		if ok {
			return c, i, nil
		}
	}
	c.Release()
	return nil, 0, river.JobSnooze(2 * time.Second)
}

func release(c *pgxpool.Conn, tenant string, slot int) {
	if c == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, e := c.Exec(ctx, `SELECT pg_advisory_unlock(hashtext($1),$2)`, tenant, slot); e != nil {
		c.Conn().Close(ctx)
	}
	c.Release()
}

// How long a capture waits in place for its connection before it is snoozed.
var connectionWait = 2 * time.Second

// connectionTurn takes one of the connection's capture slots until the
// returned function is called.
func (s *Service) connectionTurn(ctx context.Context, connection string) (func(), error) {
	lock, e := s.DB.Pool.Acquire(ctx)
	if e != nil {
		return nil, e
	}
	var acquired bool
	slot := 0
	// Most captures hold a connection only briefly, so wait a moment for a
	// turn: going back to the queue costs at least a second each time.
	for deadline := time.Now().Add(connectionWait); ; {
		for i := 0; i < max(1, s.Config.ConnectionConcurrency); i++ {
			slot = i
			e = lock.QueryRow(ctx, `SELECT pg_try_advisory_lock(hashtext($1),$2)`, "connection:"+connection, i).Scan(&acquired)
			if e != nil || acquired {
				break
			}
		}
		if e != nil || acquired || !time.Now().Before(deadline) {
			break
		}
		select {
		case <-ctx.Done():
			e = ctx.Err()
		case <-time.After(25 * time.Millisecond):
		}
		if e != nil {
			break
		}
	}
	if e != nil || !acquired {
		lock.Release()
		if e != nil {
			return nil, e
		}
		return nil, river.JobSnooze(time.Second)
	}
	return func() { release(lock, "connection:"+connection, slot) }, nil
}

func (s *Service) capture(ctx context.Context, t store.Task) error {
	if s.Registry != nil || len(s.adapterBindings()) > 0 {
		var id string
		e := s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, "SELECT adapter_id FROM captures WHERE id=$1", t.ID).Scan(&id)
		})
		if e != nil {
			return e
		}
		scoped, e := s.forAdapter(id)
		if e != nil {
			return e
		}
		return scoped.capture(ctx, t)
	}

	c, slot, e := s.slot(ctx, t.Tenant)
	if e != nil {
		return e
	}
	defer release(c, t.Tenant, slot)
	var automatic bool
	var pageSize uint32
	var url, id, provider, connection, scope, state, visibility, platform, kind, objectScope, pageCursor, mode, collectionID string
	e = s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT a.url,a.external_id,c.provider_id,coalesce(c.connection_id::text,''),c.scope,c.state,c.visibility,a.platform,a.kind,a.object_scope,c.automatic,c.page_cursor,c.page_size,c.mode,a.id FROM captures c JOIN collections a ON a.id=c.collection_id WHERE c.id=$1`, t.ID).Scan(&url, &id, &provider, &connection, &scope, &state, &visibility, &platform, &kind, &objectScope, &automatic, &pageCursor, &pageSize, &mode, &collectionID)
	})
	if e != nil {
		return e
	}
	if state != "queued" {
		return nil
	}
	var credential *pb.Credential
	var revision int64
	if connection != "" {
		credential, revision, e = s.session(ctx, t.Tenant, connection)
		if e != nil {
			return e
		}
		_, selected, err := s.connectionProvider(ctx, t.Tenant, connection)
		if err != nil || selected != provider {
			return ErrConnection
		}
	}
	policy, err := s.requireProvider(ctx, provider, adapter.CaptureFetch)
	if err != nil {
		return err
	}
	if (connection == "") != (policy.Authentication == "none") {
		return domain.ErrUnsupported
	}
	if _, e := s.requireProvider(ctx, provider, adapter.CaptureFetch); e != nil {
		return e
	}
	// A fetch that never touches the account need not wait for it: the adapter
	// is asked without the credential first and says when it needs one.
	deferred := connection != "" && mode != "check" && adapter.Supports(policy, adapter.CredentialDeferred, 1, 0)
	if connection != "" && !deferred {
		done, e := s.connectionTurn(ctx, connection)
		if e != nil {
			return e
		}
		defer done()
	}
	if mode == "check" {
		target := &pb.ObjectRef{Platform: platform, Kind: kind, ObjectScope: objectScope, ExternalId: id}
		return s.checkAccess(ctx, t, collectionID, url, target, provider, connection, scope, credential, revision)
	}
	callCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	var trailer metadata.MD
	fetch := func(credential *pb.Credential) (*pb.FetchResponse, error) {
		trailer = nil
		fetchStart := time.Now()
		r, e := s.Adapter.Fetch(callCtx, &pb.FetchRequest{PageCursor: pageCursor, PageSize: pageSize, Automatic: automatic, Platform: platform, Kind: kind, ObjectScope: objectScope, Url: url, ExternalId: id, ProviderId: provider, ConnectionId: connection, AccessScope: scope, RequestId: t.ID, Credential: credential, CredentialDeferred: credential == nil && deferred}, grpc.Trailer(&trailer))
		ProviderDuration.WithLabelValues(provider).Observe(time.Since(fetchStart).Seconds())
		ProviderResults.WithLabelValues(provider, status.Code(e).String()).Inc()
		return r, e
	}
	var r *pb.FetchResponse
	if deferred {
		r, e = fetch(nil)
		if e != nil && len(trailer.Get("credential-required")) > 0 {
			done, err := s.connectionTurn(ctx, connection)
			if err != nil {
				return err
			}
			defer done()
			r, e = fetch(credential)
		}
	} else {
		r, e = fetch(credential)
	}
	if e != nil {
		if connection != "" && status.Code(e) == codes.Unauthenticated {
			s.markReauth(ctx, t.Tenant, connection, revision)
		}
		if state := trailer.Get("source-state"); len(state) > 0 && (state[0] == "deleted" || state[0] == "suspended") {
			if err := s.markSourceState(ctx, t.Tenant, collectionID, state[0]); err != nil {
				return err
			}
		}
		if connection != "" && accessDenied(e) {
			if err := s.revokeAccess(ctx, t.Tenant, objectRef{platform, kind, objectScope, id}); err != nil {
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
	if r.ExternalId != id || r.ProviderId != provider {
		return &PermanentError{"adapter returned mismatched identity"}
	}
	if err := validateRelatedResult(policy, r, platform, kind, objectScope); err != nil {
		return err
	}
	expectedVisibility := pb.Visibility_VISIBILITY_PRIVATE
	if visibility == "public" {
		expectedVisibility = pb.Visibility_VISIBILITY_PUBLIC
	}
	if (connection == "" && r.Visibility != expectedVisibility) || (r.Visibility != pb.Visibility_VISIBILITY_PUBLIC && r.Visibility != pb.Visibility_VISIBILITY_PRIVATE) {
		return &PermanentError{"provider visibility does not match capture policy"}
	}
	if r.Visibility == pb.Visibility_VISIBILITY_PUBLIC {
		visibility = "public"
	} else {
		visibility = "private"
	}
	if len(r.Text) > 1<<20 {
		return &PermanentError{"text exceeds collection limit"}
	}
	graph, e := s.entityGraph(ctx, r)
	if e != nil {
		return e
	}
	rawSize, e := sourceBytes(r, connection != "")
	if e != nil {
		return e
	}
	p := Payload{AuthorName: r.AuthorName, PublishedAt: r.PublishedAt, Summary: r.Summary, Graph: graph, Text: r.Text, TextKind: r.TextKind, Warnings: r.Warnings, Version: r.AdapterVersion, TextSource: r.TextSource, Incomplete: r.Incomplete}
	// Keep resource positions stable in the graph after applying execution limits.
	kept := []*pb.Resource{}
	positions := map[uint32]uint32{}
	mediaCount, extraCount := 0, 0
	for i, v := range r.Resources {
		if v == nil {
			return &PermanentError{"invalid resource"}
		}
		if len(v.AltText) > 1<<20 || len(v.Purpose) > 128 {
			return &PermanentError{"resource metadata exceeds limit"}
		}
		keep := v.Kind == "image" || v.Kind == "video"
		if v.Purpose == "" {
			mediaCount++
			keep = keep && mediaCount <= s.Config.MaxMedia
		} else {
			extraCount++
			keep = keep && extraCount <= 16
		}
		if !keep {
			p.Incomplete = true
			p.Warnings = append(p.Warnings, "resource omitted: unsupported type or resource limit")
			continue
		}
		positions[uint32(i)] = uint32(len(kept))
		kept = append(kept, v)
		p.MediaDescriptions = append(p.MediaDescriptions, v.AltText)
		p.MediaSensitive = append(p.MediaSensitive, v.Sensitive)
	}
	r.Resources = kept
	if graph != nil {
		for i := range graph.Entities {
			e := &graph.Entities[i]
			indices := []uint32{}
			for _, old := range e.ResourceIndices {
				if pos, ok := positions[old]; ok {
					indices = append(indices, pos)
				}
			}
			e.ResourceIndices = indices
		}
	}
	b, _ := json.Marshal(p)
	entityReserve := 0
	if graph != nil {
		entityReserve = len(graph.Entities) * 160
	}
	e = s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
		if e := lockTenant(ctx, tx, t.Tenant); e != nil {
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
		if r.CanonicalTarget != nil {
			if e := s.resolveCaptureScope(ctx, tx, t.Tenant, t.ID, r.CanonicalTarget); e != nil {
				return e
			}
		}
		relatedJSON, _ := json.Marshal(r.RelatedTargets)
		restricted := objectRefs(r.RestrictedTargets)
		restrictedJSON, _ := json.Marshal(restricted)
		if _, e := tx.Exec(ctx, `UPDATE captures SET credential_revision=$2,related_targets=$3,next_page_cursor=$4,max_batch_size=$5,visibility=$6,restricted_targets=$7 WHERE id=$1`, t.ID, revision, relatedJSON, r.NextPageCursor, r.MaxBatchSize, visibility, restrictedJSON); e != nil {
			return e
		}
		// Whatever an account fetched, its tenant has proven it can see.
		if connection != "" {
			var root objectRef
			if e := tx.QueryRow(ctx, `SELECT a.platform,a.kind,a.object_scope,a.external_id FROM captures c JOIN collections a ON a.id=c.collection_id WHERE c.id=$1`, t.ID).Scan(&root.Platform, &root.Kind, &root.ObjectScope, &root.ExternalID); e != nil {
				return e
			}
			if e := grantAccess(ctx, tx, t.Tenant, connection, "fetch", append(restricted, root)); e != nil {
				return e
			}
		}
		if e := persistSources(ctx, tx, t.Tenant, t.ID, r); e != nil {
			return e
		}
		if e := measureUsage(ctx, tx); e != nil {
			return e
		}
		tag, e := tx.Exec(ctx, `UPDATE tenants SET reserved_bytes=reserved_bytes+$2 WHERE id=$1 AND (tenant_unlimited() OR used_bytes+reserved_bytes+$2<=quota_bytes)`, t.Tenant, len(b)+rawSize+entityReserve)
		if e != nil {
			return e
		}
		if tag.RowsAffected() == 0 {
			return domain.ErrQuota
		}
		if _, e = tx.Exec(ctx, `UPDATE captures SET state='downloading',payload=$2,adapter_version=$3,content_reserved=$4 WHERE id=$1`, t.ID, b, r.AdapterVersion, len(b)+rawSize+entityReserve); e != nil {
			return e
		}
		n := 0
		for _, v := range r.Resources {
			var aid string
			cacheKey := ""
			if v.ImmutableKey != "" {
				key, _ := json.Marshal([]string{platform, v.ImmutableKey})
				cacheKey = store.Hash(string(key))
			}
			if e = tx.QueryRow(ctx, `INSERT INTO assets(capture_id,position,source_url,kind,cache_key,alt_text,sensitive,purpose) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, t.ID, n, v.Url, v.Kind, cacheKey, v.AltText, v.Sensitive, v.Purpose).Scan(&aid); e != nil {
				return e
			}
			n++
			if e = s.Enqueue(ctx, tx, t.Tenant, aid, "download"); e != nil {
				return e
			}
		}
		return s.finalizeSettled(ctx, tx, t.Tenant, t.ID)
	})
	return e
}

// finalizeSettled queues a capture's finalization once none of its assets is
// pending. Callers hold the tenant lock, which orders the asset completions of
// a capture, so the last one to settle sees the others done.
func (s *Service) finalizeSettled(ctx context.Context, tx pgx.Tx, tenant, cid string) error {
	var pending bool
	if e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT FROM assets WHERE capture_id=$1 AND state='pending')`, cid).Scan(&pending); e != nil || pending {
		return e
	}
	return s.Enqueue(ctx, tx, tenant, cid, "finalize")
}

func (s *Service) finalize(ctx context.Context, tenant, cid string) error {
	return s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		if e := lockTenant(ctx, tx, tenant); e != nil {
			return e
		}
		if e := lockCaptureCollection(ctx, tx, cid); e != nil {
			return e
		}
		var aid, state string
		var raw []byte
		var reserved int64
		if e := tx.QueryRow(ctx, `SELECT collection_id,state,payload,content_reserved FROM captures WHERE id=$1 FOR UPDATE`, cid).Scan(&aid, &state, &raw, &reserved); e != nil {
			return e
		}
		if state != "downloading" {
			return nil
		}
		aa, e := assets(ctx, tx, cid)
		if e != nil {
			return e
		}
		for _, a := range aa {
			if a.State == "pending" {
				return nil
			}
		}
		if e := validateCaptureConnection(ctx, tx, cid); e != nil {
			return e
		}
		var p Payload
		if e = json.Unmarshal(raw, &p); e != nil {
			return e
		}
		good := 0
		partial := p.Incomplete
		for _, a := range aa {
			if a.State == "ready" {
				if a.Purpose == "" {
					good++
				}
			} else {
				partial = true
			}
		}
		if p.Text == "" && good == 0 && p.Graph == nil {
			return s.failCaptureTx(ctx, tx, tenant, cid, "no text or media could be saved")
		}
		if e = persistEntities(ctx, tx, cid, &p, aa); e != nil {
			return e
		}
		raw, _ = json.Marshal(p)
		digestData := revisionSignature(p, aa, p.Graph)
		var digest string
		if e = tx.QueryRow(ctx, `SELECT encode(digest($1::jsonb::text,'sha256'),'hex')`, digestData).Scan(&digest); e != nil {
			return e
		}
		// Compare with the newest revision this tenant can read: equal content from
		// any source is the same version for everyone who may see it.
		var previous, previousID, previousVisibility *string
		e = tx.QueryRow(ctx, `SELECT r.content_hash,r.id,r.visibility FROM collections a LEFT JOIN LATERAL (SELECT head.* FROM revisions head WHERE head.collection_id=a.id ORDER BY head.created_at DESC,head.id DESC LIMIT 1) r ON TRUE WHERE a.id=$1`, aid).Scan(&previous, &previousID, &previousVisibility)
		if e != nil {
			return e
		}
		// Compare the retained snapshot under today's context policy as well, so
		// adopting the policy does not manufacture a one-off revision.
		if previousID != nil && p.Graph != nil {
			hasContext := false
			for _, entity := range p.Graph.Entities {
				hasContext = hasContext || entity.ContextOnly
			}
			if hasContext {
				var previousRaw []byte
				var previousCapture string
				if e = tx.QueryRow(ctx, `SELECT payload,capture_id FROM revisions WHERE id=$1`, *previousID).Scan(&previousRaw, &previousCapture); e != nil {
					return e
				}
				var previousPayload Payload
				if e = json.Unmarshal(previousRaw, &previousPayload); e != nil {
					return e
				}
				previousAssets, err := assets(ctx, tx, previousCapture)
				if err != nil {
					return err
				}
				var previousDigest string
				if e = tx.QueryRow(ctx, `SELECT encode(digest($1::jsonb::text,'sha256'),'hex')`, revisionSignature(previousPayload, previousAssets, p.Graph)).Scan(&previousDigest); e != nil {
					return e
				}
				previous = &previousDigest
			}
		}
		revisionID := previousID
		if previous != nil && *previous == digest && *previousVisibility == "private" {
			if _, e = tx.Exec(ctx, `SELECT publish_revision($1,$2)`, *previousID, cid); e != nil {
				return e
			}
		}
		if previous == nil || *previous != digest {
			var rid string
			e = tx.QueryRow(ctx, `INSERT INTO revisions(collection_id,capture_id,content_hash,payload,content_bytes,visibility) SELECT $1,$2,$3,$4,$5,visibility FROM captures WHERE id=$2 RETURNING id`, aid, cid, digest, raw, len(raw)).Scan(&rid)
			if e != nil {
				return e
			}
			// Restricted embedded objects gate this revision for tenants that only
			// proved access to the root object.
			if _, e = tx.Exec(ctx, `INSERT INTO revision_access_requirements(revision_id,platform,kind,object_scope,external_id) SELECT $1,x->>'platform',x->>'kind',x->>'object_scope',x->>'external_id' FROM captures c CROSS JOIN LATERAL jsonb_array_elements(c.restricted_targets) x WHERE c.id=$2 AND c.visibility='private' ON CONFLICT DO NOTHING`, rid, cid); e != nil {
				return e
			}
			if e = linkEntities(ctx, tx, rid, p.Graph); e != nil {
				return e
			}
			revisionID = &rid
			if _, e = tx.Exec(ctx, `UPDATE collections SET current_revision=$2 WHERE id=$1`, aid, rid); e != nil {
				return e
			}
		}
		if e = releaseAssetReservations(ctx, tx, tenant, cid); e != nil {
			return e
		}
		// The reservation becomes stored content here, so the kept total is
		// measured again before the next quota check.
		if _, e = tx.Exec(ctx, `UPDATE tenants SET reserved_bytes=reserved_bytes-$2,used_at=NULL WHERE id=$1`, tenant, reserved); e != nil {
			return e
		}
		state = "complete"
		if partial {
			state = "partial"
		}
		if _, e = tx.Exec(ctx, `UPDATE captures SET state=$2,content_reserved=0,payload=NULL,finished_at=now(),revision_id=$3 WHERE id=$1`, cid, state, revisionID); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, `UPDATE collections SET observed_at=now(),source_state=NULL,source_state_at=NULL WHERE id=$1`, aid); e != nil {
			return e
		}
		var previousCollection *string
		if e = tx.QueryRow(ctx, `SELECT refresh_from FROM captures WHERE id=$1`, cid).Scan(&previousCollection); e != nil {
			return e
		}
		if previousCollection != nil && *previousCollection != aid {
			// A change of source permissions is another historical snapshot of
			// the same logical collection. Preserve completed saved history.
			if _, e = tx.Exec(ctx, `DELETE FROM tenant_collections WHERE collection_id=$1 AND EXISTS(SELECT FROM collections WHERE id=$1 AND current_revision IS NULL)`, *previousCollection); e != nil {
				return e
			}
			if _, e = tx.Exec(ctx, `SELECT mark_unreferenced($1)`, *previousCollection); e != nil {
				return e
			}
		}
		return s.deliveries(ctx, tx, tenant, cid)
	})
}

// deliveries runs once a capture reaches its final state.
func (s *Service) deliveries(ctx context.Context, tx pgx.Tx, t, cid string) error {
	// Related captures wait for this one; start them now instead of on their
	// fallback poll. A submission's related task is idempotent.
	waiting, e := tx.Query(ctx, `SELECT id FROM submissions WHERE capture_id=$1 AND related_state='pending' AND NOT collection_stopped`, cid)
	if e != nil {
		return e
	}
	submissions, e := pgx.CollectRows(waiting, pgx.RowTo[string])
	if e != nil {
		return e
	}
	for _, id := range submissions {
		if e = s.Enqueue(ctx, tx, t, id, "related"); e != nil {
			return e
		}
	}
	rows, e := tx.Query(ctx, `SELECT tenant_id,id FROM capture_deliveries($1)`, cid)
	if e != nil {
		return e
	}
	ids := []store.Task{}
	for rows.Next() {
		var id store.Task
		if e = rows.Scan(&id.Tenant, &id.ID); e != nil {
			rows.Close()
			return e
		}
		ids = append(ids, id)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	for _, id := range ids {
		if e = s.Enqueue(ctx, tx, id.Tenant, id.ID, "deliver"); e != nil {
			return e
		}
	}
	return nil
}

func releaseAssetReservations(ctx context.Context, tx pgx.Tx, tenant, cid string) error {
	var n int64
	if e := tx.QueryRow(ctx, `SELECT coalesce(sum(reserved_bytes),0) FROM assets WHERE capture_id=$1`, cid).Scan(&n); e != nil {
		return e
	}
	if _, e := tx.Exec(ctx, `UPDATE tenants SET reserved_bytes=reserved_bytes-$2 WHERE id=$1`, tenant, n); e != nil {
		return e
	}
	_, e := tx.Exec(ctx, `UPDATE assets SET reserved_bytes=0 WHERE capture_id=$1`, cid)
	return e
}

func lockCaptureCollection(ctx context.Context, tx pgx.Tx, cid string) error {
	var id string
	return tx.QueryRow(ctx, `SELECT id FROM collections WHERE id=(SELECT collection_id FROM captures WHERE id=$1) FOR UPDATE`, cid).Scan(&id)
}

func (s *Service) failCaptureTx(ctx context.Context, tx pgx.Tx, t, id, msg string) error {
	if e := lockCaptureCollection(ctx, tx, id); e != nil {
		return e
	}
	var n int64
	var state string
	if e := tx.QueryRow(ctx, `SELECT content_reserved,state FROM captures WHERE id=$1 FOR UPDATE`, id).Scan(&n, &state); e != nil {
		return e
	}
	if state == "complete" || state == "partial" || state == "failed" {
		return nil
	}
	if e := releaseAssetReservations(ctx, tx, t, id); e != nil {
		return e
	}
	if _, e := tx.Exec(ctx, `UPDATE assets SET state='failed',error=$2 WHERE capture_id=$1 AND state='pending'`, id, msg); e != nil {
		return e
	}
	if _, e := tx.Exec(ctx, `UPDATE objects SET state='garbage' WHERE state='pending' AND id IN(SELECT object_id FROM assets WHERE capture_id=$1)`, id); e != nil {
		return e
	}
	if _, e := tx.Exec(ctx, `UPDATE tenants SET reserved_bytes=reserved_bytes-$2 WHERE id=$1`, t, n); e != nil {
		return e
	}
	if _, e := tx.Exec(ctx, `DELETE FROM source_responses WHERE capture_id=$1`, id); e != nil {
		return e
	}
	if _, e := tx.Exec(ctx, `UPDATE captures SET state='failed',error=$2,content_reserved=0,payload=NULL,finished_at=now() WHERE id=$1`, id, msg); e != nil {
		return e
	}
	return s.deliveries(ctx, tx, t, id)
}

func (s *Service) fail(ctx context.Context, t store.Task, msg string) error {
	return s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
		if e := lockTenant(ctx, tx, t.Tenant); e != nil {
			return e
		}
		switch t.Type {
		case "capture", "finalize":
			return s.failCaptureTx(ctx, tx, t.Tenant, t.ID, msg)
		case "download":
			var cid, state string
			var n int64
			var oid *string
			if e := tx.QueryRow(ctx, `SELECT capture_id,state,reserved_bytes,object_id FROM assets WHERE id=$1 FOR UPDATE`, t.ID).Scan(&cid, &state, &n, &oid); e != nil {
				return e
			}
			if state != "pending" {
				return nil
			}
			if _, e := tx.Exec(ctx, `UPDATE tenants SET reserved_bytes=reserved_bytes-$2 WHERE id=$1`, t.Tenant, n); e != nil {
				return e
			}
			if _, e := tx.Exec(ctx, `UPDATE assets SET state='failed',error=$2,reserved_bytes=0 WHERE id=$1`, t.ID, msg); e != nil {
				return e
			}
			if oid != nil {
				if _, e := tx.Exec(ctx, `UPDATE objects SET state='garbage' WHERE id=$1 AND state='pending'`, *oid); e != nil {
					return e
				}
			}
			return s.finalizeSettled(ctx, tx, t.Tenant, cid)
		case "related":
			_, e := tx.Exec(ctx, `UPDATE submissions SET related_state='failed',related_error=$2 WHERE id=$1 AND related_state='pending'`, t.ID, msg)
			return e
		case "thumbnail":
			return failThumbnail(ctx, tx, t.ID, msg)
		case "refresh_batch":
			_, e := tx.Exec(ctx, `UPDATE refresh_batches SET state='failed',error=$2 WHERE id=$1 AND state='running'`, t.ID, msg)
			return e
		}
		return nil
	})
}

func (s *Service) taskPaused(ctx context.Context, t store.Task) (bool, error) {
	var query string
	switch t.Type {
	case "capture", "finalize":
		query = `SELECT EXISTS(SELECT FROM captures WHERE id=$1 AND paused)`
	case "download":
		query = `SELECT EXISTS(SELECT FROM assets a JOIN captures c ON c.id=a.capture_id WHERE a.id=$1 AND c.paused)`
	case "related":
		query = `SELECT EXISTS(SELECT FROM submissions s JOIN captures c ON c.id=s.capture_id WHERE s.id=$1 AND c.paused)`
	default:
		return false, nil
	}
	var paused bool
	err := s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error { return tx.QueryRow(ctx, query, t.ID).Scan(&paused) })
	return paused, err
}
