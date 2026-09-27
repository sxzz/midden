package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
	var e error
	switch j.Args.Type {
	case "capture":
		e = w.S.capture(ctx, j.Args)
	case "download":
		e = w.S.download(ctx, j.Args)
	case "deliver":
		e = w.S.deliver(ctx, j.Args)
	case "status":
		e = w.S.submissionStatus(ctx, j.Args)
	case "inbox":
		e = w.S.processInbox(ctx, j.Args)
	case "reply":
		e = w.S.reply(ctx, j.Args)
	case "finalize":
		e = w.S.finalize(ctx, j.Args.Tenant, j.Args.ID)
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
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, e := c.Exec(ctx, `SELECT pg_advisory_unlock(hashtext($1),$2)`, tenant, slot); e != nil {
		c.Conn().Close(ctx)
	}
	c.Release()
}

func (s *Service) capture(ctx context.Context, t store.Task) error {
	if len(s.Adapters) > 0 {
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
	var url, id, provider, connection, scope, state, visibility, platform, kind, objectScope string
	e = s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT a.url,a.external_id,c.provider_id,coalesce(c.connection_id::text,''),c.scope,c.state,c.visibility,a.platform,a.kind,a.object_scope FROM captures c JOIN archives a ON a.id=c.archive_id WHERE c.id=$1`, t.ID).Scan(&url, &id, &provider, &connection, &scope, &state, &visibility, &platform, &kind, &objectScope)
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
		lock, e := s.DB.Pool.Acquire(ctx)
		if e != nil {
			return e
		}
		var acquired bool
		connectionSlot := 0
		for i := 0; i < max(1, s.Config.ConnectionConcurrency); i++ {
			connectionSlot = i
			e = lock.QueryRow(ctx, `SELECT pg_try_advisory_lock(hashtext($1),$2)`, "connection:"+connection, i).Scan(&acquired)
			if e != nil || acquired {
				break
			}
		}
		if e != nil || !acquired {
			lock.Release()
			if e != nil {
				return e
			}
			return river.JobSnooze(time.Second)
		}
		defer release(lock, "connection:"+connection, connectionSlot)
		credential, revision, e = s.session(ctx, t.Tenant, connection)
		if e != nil {
			return e
		}
	}
	if connection != "" {
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
	callCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	var trailer metadata.MD
	fetchStart := time.Now()
	r, e := s.Adapter.Fetch(callCtx, &pb.FetchRequest{Platform: platform, Kind: kind, ObjectScope: objectScope, Url: url, ExternalId: id, ProviderId: provider, ConnectionId: connection, AccessScope: scope, RequestId: t.ID, Credential: credential}, grpc.Trailer(&trailer))
	ProviderDuration.WithLabelValues(provider).Observe(time.Since(fetchStart).Seconds())
	ProviderResults.WithLabelValues(provider, status.Code(e).String()).Inc()
	if e != nil {
		if connection != "" && status.Code(e) == codes.Unauthenticated {
			s.markReauth(ctx, t.Tenant, connection, revision)
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
		return &PermanentError{"text exceeds archive limit"}
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
		if connection != "" {
			if e := s.resolveCaptureScope(ctx, tx, t.Tenant, t.ID, visibility); e != nil {
				return e
			}
		}
		if _, e := tx.Exec(ctx, `UPDATE captures SET credential_revision=$2 WHERE id=$1`, t.ID, revision); e != nil {
			return e
		}
		if e := persistSources(ctx, tx, t.Tenant, t.ID, r); e != nil {
			return e
		}
		tag, e := tx.Exec(ctx, `UPDATE tenants SET reserved_bytes=reserved_bytes+$2 WHERE id=$1 AND tenant_usage()+reserved_bytes+$2<=quota_bytes`, t.Tenant, len(b)+rawSize+entityReserve)
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
				mediaScope := scope
				if visibility == "public" {
					mediaScope = "public"
				}
				key, _ := json.Marshal([]string{platform, mediaScope, v.ImmutableKey})
				cacheKey = store.Hash(string(key))
			}
			if e = tx.QueryRow(ctx, `INSERT INTO assets(tenant_id,capture_id,position,source_url,visibility,kind,cache_key,alt_text,sensitive,purpose) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, t.Tenant, t.ID, n, v.Url, visibility, v.Kind, cacheKey, v.AltText, v.Sensitive, v.Purpose).Scan(&aid); e != nil {
				return e
			}
			n++
			if e = s.Enqueue(ctx, tx, t.Tenant, aid, "download"); e != nil {
				return e
			}
		}
		return s.Enqueue(ctx, tx, t.Tenant, t.ID, "finalize")
	})
	return e
}

func (s *Service) finalize(ctx context.Context, tenant, cid string) error {
	return s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		if e := lockTenant(ctx, tx, tenant); e != nil {
			return e
		}
		if e := lockCaptureArchive(ctx, tx, cid); e != nil {
			return e
		}
		var aid, state string
		var raw []byte
		var reserved int64
		if e := tx.QueryRow(ctx, `SELECT archive_id,state,payload,content_reserved FROM captures WHERE id=$1 FOR UPDATE`, cid).Scan(&aid, &state, &raw, &reserved); e != nil {
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
		type sig struct {
			Purpose   string
			Hash      string
			AltText   string
			Sensitive bool
			State     string
			Error     string
		}
		ss := []sig{}
		for _, a := range aa {
			ss = append(ss, sig{a.Purpose, a.Hash, a.AltText, a.Sensitive, a.State, a.Error})
			if a.State == "ready" {
				if a.Purpose == "" {
					good++
				}
			} else {
				partial = true
			}
		}
		if p.Text == "" && good == 0 && p.Graph == nil {
			return s.failCaptureTx(ctx, tx, tenant, cid, "no text or media could be archived")
		}
		if e = persistEntities(ctx, tx, tenant, cid, &p, aa); e != nil {
			return e
		}
		raw, _ = json.Marshal(p)
		digestData, _ := json.Marshal(struct {
			Text, Kind, Summary, AuthorName, PublishedAt string
			Graph                                        *domain.EntityGraph
			Warnings                                     []string
			Assets                                       []sig
		}{p.Text, p.TextKind, p.Summary, p.AuthorName, p.PublishedAt, p.Graph, p.Warnings, ss})
		var digest string
		if e = tx.QueryRow(ctx, `SELECT encode(digest($1::jsonb::text,'sha256'),'hex')`, digestData).Scan(&digest); e != nil {
			return e
		}
		var previous *string
		var previousID *string
		e = tx.QueryRow(ctx, `SELECT r.content_hash,r.id FROM archives a LEFT JOIN revisions r ON r.id=a.current_revision WHERE a.id=$1`, aid).Scan(&previous, &previousID)
		if e != nil {
			return e
		}
		revisionID := previousID
		if previous == nil || *previous != digest {
			var rid string
			e = tx.QueryRow(ctx, `INSERT INTO revisions(tenant_id,archive_id,capture_id,content_hash,payload,content_bytes,visibility) SELECT $1,$2,$3,$4,$5,$6,visibility FROM captures WHERE id=$3 RETURNING id`, tenant, aid, cid, digest, raw, len(raw)).Scan(&rid)
			if e != nil {
				return e
			}
			if e = linkEntities(ctx, tx, tenant, cid, rid, p.Graph); e != nil {
				return e
			}
			revisionID = &rid
			if _, e = tx.Exec(ctx, `UPDATE archives SET current_revision=$2 WHERE id=$1`, aid, rid); e != nil {
				return e
			}
		}
		if e = releaseAssetReservations(ctx, tx, tenant, cid); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, `UPDATE tenants SET reserved_bytes=reserved_bytes-$2 WHERE id=$1`, tenant, reserved); e != nil {
			return e
		}
		state = "complete"
		if partial {
			state = "partial"
		}
		if _, e = tx.Exec(ctx, `UPDATE captures SET state=$2,content_reserved=0,payload=NULL,finished_at=now(),revision_id=$3 WHERE id=$1`, cid, state, revisionID); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, `UPDATE archives SET observed_at=now() WHERE id=$1`, aid); e != nil {
			return e
		}
		var previousArchive *string
		if e = tx.QueryRow(ctx, `SELECT refresh_from FROM captures WHERE id=$1`, cid).Scan(&previousArchive); e != nil {
			return e
		}
		if previousArchive != nil && *previousArchive != aid {
			if _, e = tx.Exec(ctx, `DELETE FROM tenant_archives WHERE archive_id=$1`, *previousArchive); e != nil {
				return e
			}
			if _, e = tx.Exec(ctx, `SELECT mark_unreferenced($1)`, *previousArchive); e != nil {
				return e
			}
		}
		return s.deliveries(ctx, tx, tenant, cid)
	})
}

func (s *Service) deliveries(ctx context.Context, tx pgx.Tx, t, cid string) error {
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

func lockCaptureArchive(ctx context.Context, tx pgx.Tx, cid string) error {
	var id string
	return tx.QueryRow(ctx, `SELECT id FROM archives WHERE id=(SELECT archive_id FROM captures WHERE id=$1) FOR UPDATE`, cid).Scan(&id)
}

func (s *Service) failCaptureTx(ctx context.Context, tx pgx.Tx, t, id, msg string) error {
	if e := lockCaptureArchive(ctx, tx, id); e != nil {
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
			return s.Enqueue(ctx, tx, t.Tenant, cid, "finalize")
		case "deliver":
			_, e := tx.Exec(ctx, `UPDATE submissions SET state='failed',error=$2 WHERE id=$1 AND state<>'sent'`, t.ID, msg)
			return e
		case "inbox":
			_, e := tx.Exec(ctx, `UPDATE inbox SET state='failed',payload=payload-'account_import' WHERE id=$1 AND state='pending'`, t.ID)
			return e
		case "reply":
			_, e := tx.Exec(ctx, `UPDATE replies SET state='failed' WHERE id=$1 AND state='pending'`, t.ID)
			return e
		}
		return nil
	})
}
