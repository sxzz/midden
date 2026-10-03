package app

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"os"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"monitor/internal/domain"
	"monitor/internal/store"
)

// How long a media task waits in place for another task handling the same file.
var mediaWait = 2 * time.Second

func (s *Service) download(ctx context.Context, t store.Task) (resultErr error) {
	started := time.Now()
	stage := "lock_asset"
	log := slog.Default().With("task_id", t.ID, "tenant_id", t.Tenant)
	defer func() {
		fields := []any{"stage", stage, "elapsed_ms", time.Since(started).Milliseconds()}
		if resultErr != nil {
			log.WarnContext(ctx, "media task failed", append(fields, diagnosticError(resultErr)...)...)
		} else {
			log.InfoContext(ctx, "media task finished", fields...)
		}
	}()

	// A per-asset lock also protects against overlap during job rescue.
	c, e := s.DB.Pool.Acquire(ctx)
	if e != nil {
		return e
	}
	var ok bool
	e = c.QueryRow(ctx, `SELECT pg_try_advisory_lock(hashtext($1),-1)`, t.ID).Scan(&ok)
	if e != nil {
		c.Release()
		return e
	}
	if !ok {
		c.Release()
		return river.JobSnooze(time.Second)
	}
	defer release(c, t.ID, -1)
	var cacheKey string
	e = s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT cache_key FROM assets WHERE id=$1`, t.ID).Scan(&cacheKey)
	})
	if e != nil {
		return e
	}
	if cacheKey != "" {
		// The same file usually arrives from several captures at once and the
		// first one settles it quickly, so wait a moment instead of requeueing.
		for deadline := time.Now().Add(mediaWait); ; {
			e = c.QueryRow(ctx, `SELECT pg_try_advisory_lock(hashtext($1),-2)`, cacheKey).Scan(&ok)
			if e != nil {
				return e
			}
			if ok || !time.Now().Before(deadline) {
				break
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(25 * time.Millisecond):
			}
		}
		if !ok {
			return river.JobSnooze(time.Second)
		}
		defer func() {
			unlockCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if _, err := c.Exec(unlockCtx, `SELECT pg_advisory_unlock(hashtext($1),-2)`, cacheKey); err != nil {
				c.Conn().Close(unlockCtx)
			}
		}()
		stage = "cache_lookup"
		hit, err := s.reuseMedia(ctx, t, cacheKey)
		if err != nil || hit {
			log.InfoContext(ctx, "media cache lookup", "hit", hit)
			return err
		}
	}
	var kind, source, state, key, cid, oid string
	var reserved int64
	stage = "prepare_object"
	e = s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
		if e := lockTenant(ctx, tx, t.Tenant); e != nil {
			return e
		}
		var objectID *string
		e := tx.QueryRow(ctx, `SELECT kind,source_url,state,reserved_bytes,capture_id,object_id FROM assets WHERE id=$1 FOR UPDATE`, t.ID).Scan(&kind, &source, &state, &reserved, &cid, &objectID)
		if e != nil {
			return e
		}
		if e := validateCaptureConnection(ctx, tx, cid); e != nil {
			return e
		}
		if state != "pending" {
			return nil
		}
		if objectID == nil {
			oid = uuid.NewString()
			key = "objects/" + oid
			if _, e = tx.Exec(ctx, `INSERT INTO objects(id,uploaded_by,object_key) VALUES($1,$2,$3)`, oid, t.Tenant, key); e != nil {
				return e
			}
			_, e = tx.Exec(ctx, `UPDATE assets SET object_id=$2 WHERE id=$1`, t.ID, oid)
			return e
		}
		oid = *objectID
		return tx.QueryRow(ctx, `SELECT object_key FROM objects WHERE id=$1 AND state='pending'`, oid).Scan(&key)
	})
	if e != nil {
		return e
	}
	if state != "pending" {
		return nil
	}
	u, e := url.Parse(source)
	if e != nil || u.User != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return &PermanentError{"invalid media URL"}
	}
	log = log.With("capture_id", cid, "media_kind", kind, "source_host", u.Hostname())
	stage = "http_request"
	log.InfoContext(ctx, "media request started", "client_timeout_ms", s.HTTP.Timeout.Milliseconds())
	trace := &httptrace.ClientTrace{
		DNSDone: func(info httptrace.DNSDoneInfo) {
			log.InfoContext(ctx, "media network phase", append([]any{"phase", "dns", "elapsed_ms", time.Since(started).Milliseconds()}, diagnosticError(info.Err)...)...)
		},
		ConnectDone: func(network, _ string, err error) {
			log.InfoContext(ctx, "media network phase", append([]any{"phase", "connect", "network", network, "elapsed_ms", time.Since(started).Milliseconds()}, diagnosticError(err)...)...)
		},
		TLSHandshakeDone: func(_ tls.ConnectionState, err error) {
			log.InfoContext(ctx, "media network phase", append([]any{"phase", "tls", "elapsed_ms", time.Since(started).Milliseconds()}, diagnosticError(err)...)...)
		},
		GotFirstResponseByte: func() {
			log.InfoContext(ctx, "media network phase", "phase", "first_byte", "elapsed_ms", time.Since(started).Milliseconds())
		},
	}
	req, e := http.NewRequestWithContext(httptrace.WithClientTrace(ctx, trace), "GET", source, nil)
	if e != nil {
		return &PermanentError{"invalid media URL"}
	}
	resp, e := s.HTTP.Do(req)
	if e != nil {
		return fmt.Errorf("media request failed: %w", e)
	}
	defer resp.Body.Close()
	log.InfoContext(ctx, "media response headers", "http_status", resp.StatusCode, "content_length", resp.ContentLength, "retry_after_ms", parseRetry(resp.Header.Get("Retry-After")).Milliseconds(), "elapsed_ms", time.Since(started).Milliseconds())
	stage = "validate_response"
	if resp.StatusCode == 429 || resp.StatusCode >= 500 {
		return &RetryError{After: parseRetry(resp.Header.Get("Retry-After")), Err: fmt.Errorf("media upstream unavailable")}
	}
	if resp.StatusCode != 200 {
		return &PermanentError{"media provider rejected request"}
	}
	// The tenant's remaining storage is the only size limit. Reserve the
	// declared size so concurrent downloads cannot overrun it together; a
	// response without one is capped at what is left and charged on commit.
	stage = "reserve_storage"
	want := max(resp.ContentLength, 0)
	var allowed int64
	e = s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
		if e := lockTenant(ctx, tx, t.Tenant); e != nil {
			return e
		}
		if e := tx.QueryRow(ctx, `SELECT CASE WHEN tenant_unlimited() THEN 9223372036854775807 ELSE quota_bytes-tenant_usage()-reserved_bytes+$2 END FROM tenants WHERE id=$1`, t.Tenant, reserved).Scan(&allowed); e != nil {
			return e
		}
		log.InfoContext(ctx, "media storage reservation", "available_bytes", allowed, "requested_bytes", want)
		if allowed <= 0 || want > allowed {
			return domain.ErrQuota
		}
		if want == reserved {
			return nil
		}
		if _, e := tx.Exec(ctx, `UPDATE tenants SET reserved_bytes=reserved_bytes-$3+$2 WHERE id=$1`, t.Tenant, want, reserved); e != nil {
			return e
		}
		_, e := tx.Exec(ctx, `UPDATE assets SET reserved_bytes=$2 WHERE id=$1`, t.ID, want)
		return e
	})
	if e != nil {
		return e
	}
	reserved = want
	if resp.ContentLength >= 0 {
		allowed = want
	}
	f, e := os.CreateTemp("", "monitor-media-*")
	if e != nil {
		return e
	}
	defer os.Remove(f.Name())
	defer f.Close()
	h := sha256.New()
	stage = "read_body"
	// Read one byte past the allowance to detect an oversized body.
	readLimit := allowed
	if readLimit < math.MaxInt64 {
		readLimit++
	}
	n, e := io.Copy(io.MultiWriter(f, h), io.LimitReader(resp.Body, readLimit))
	if e != nil {
		return fmt.Errorf("media download interrupted: %w", e)
	}
	log.InfoContext(ctx, "media body received", "bytes", n, "elapsed_ms", time.Since(started).Milliseconds())
	if n > allowed {
		return domain.ErrQuota
	}
	if n == 0 {
		return &PermanentError{"empty media"}
	}
	if _, e = f.Seek(0, 0); e != nil {
		return e
	}
	header := make([]byte, 512)
	k, _ := f.Read(header)
	mime := mediaType(header[:k])
	if (kind == "video" && mime != "video/mp4" && mime != "video/webm") || (kind == "image" && mime != "image/jpeg" && mime != "image/png" && mime != "image/webp") {
		return &PermanentError{"unsupported media format"}
	}
	if _, e = f.Seek(0, 0); e != nil {
		return e
	}
	digest := hex.EncodeToString(h.Sum(nil))
	// Serialize the existence check and upload across tenants; stored bytes are shared.
	// Keep the remote upload outside a database transaction.
	stage = "dedup_lock"
	hashKey := digest
	if _, e = c.Exec(ctx, `SELECT pg_advisory_lock(hashtextextended($1,2))`, hashKey); e != nil {
		return e
	}
	defer func() {
		unlockCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := c.Exec(unlockCtx, `SELECT pg_advisory_unlock(hashtextextended($1,2))`, hashKey); err != nil {
			c.Conn().Close(unlockCtx)
		}
	}()
	var exists bool
	if e = s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT EXISTS(SELECT FROM blobs WHERE hash=$1)`, digest).Scan(&exists)
	}); e != nil {
		return e
	}
	log.InfoContext(ctx, "media blob lookup", "hit", exists, "bytes", n)
	if !exists {
		stage = "object_upload"
		log.InfoContext(ctx, "media object upload started", "bytes", n)
		if e = s.Blobs.Put(ctx, key, f, n, mime); e != nil {
			return fmt.Errorf("object upload failed: %w", e)
		}
	}
	stage = "commit_asset"
	return s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
		if e := lockTenant(ctx, tx, t.Tenant); e != nil {
			return e
		}
		var state string
		if e := tx.QueryRow(ctx, `SELECT state FROM assets WHERE id=$1 FOR UPDATE`, t.ID).Scan(&state); e != nil {
			return e
		}
		if state != "pending" {
			return nil
		}
		if e := validateCaptureConnection(ctx, tx, cid); e != nil {
			return e
		}
		var bid, bkey string
		e := tx.QueryRow(ctx, `SELECT id,object_key FROM blobs WHERE hash=$1`, digest).Scan(&bid, &bkey)
		if errors.Is(e, pgx.ErrNoRows) {
			if exists {
				// Retention GC may have removed the cached Blob after the check.
				return fmt.Errorf("cached media expired before attachment")
			}
			e = tx.QueryRow(ctx, `INSERT INTO blobs(hash,object_key,size,mime) VALUES($1,$2,$3,$4) RETURNING id,object_key`, digest, key, n, mime).Scan(&bid, &bkey)
		}
		if e != nil {
			return e
		}
		charge := n
		objectState := "attached"
		if bkey != key {
			objectState = "garbage"
		}
		var alreadyCounted bool
		e = tx.QueryRow(ctx, `SELECT EXISTS(
          SELECT FROM assets a JOIN revisions r ON r.capture_id=a.capture_id
          JOIN tenant_collections ta ON ta.collection_id=r.collection_id JOIN blobs b ON b.id=a.blob_id WHERE b.hash=$1
          UNION ALL SELECT FROM assets a JOIN blobs b ON b.id=a.blob_id WHERE a.capture_id=$2 AND b.hash=$1 AND a.state='ready'
        )`, digest, cid).Scan(&alreadyCounted)
		if e != nil {
			return e
		}
		if alreadyCounted {
			charge = 0
		}
		tag, e := tx.Exec(ctx, `UPDATE tenants SET reserved_bytes=reserved_bytes-$3+$2 WHERE id=$1 AND (tenant_unlimited() OR tenant_usage()+reserved_bytes-$3+$2<=quota_bytes)`, t.Tenant, charge, reserved)
		if e != nil {
			return e
		}
		if tag.RowsAffected() == 0 {
			return domain.ErrQuota
		}
		if _, e = tx.Exec(ctx, `UPDATE objects SET state=$2 WHERE id=$1 AND state='pending'`, oid, objectState); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, `UPDATE assets SET state='ready',blob_id=$2,reserved_bytes=$3 WHERE id=$1`, t.ID, bid, charge); e != nil {
			return e
		}
		if e = s.enqueueThumbnail(ctx, tx, t.Tenant, bid); e != nil {
			return e
		}
		return s.finalizeSettled(ctx, tx, t.Tenant, cid)
	})
}

func parseRetry(s string) time.Duration {
	if n, e := strconv.Atoi(s); e == nil && n > 0 {
		return time.Duration(n) * time.Second
	}
	if t, e := http.ParseTime(s); e == nil {
		return max(time.Duration(0), time.Until(t))
	}
	return 0
}

// Garbage keys are never reused. Claim first; retry deletions safely after crashes.
// Collect deletes garbage objects of every tenant; uploads are shared content.
func (s *Service) Collect(ctx context.Context, grace time.Duration) error {
	type obj struct{ ID, Key string }
	var list []obj
	rows, e := s.DB.Pool.Query(ctx, `SELECT id,object_key FROM claim_garbage_objects($1::interval,100)`, fmt.Sprintf("%f seconds", grace.Seconds()))
	if e != nil {
		return e
	}
	for rows.Next() {
		var o obj
		if e = rows.Scan(&o.ID, &o.Key); e != nil {
			rows.Close()
			return e
		}
		list = append(list, o)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	for _, o := range list {
		if e = s.Blobs.Delete(ctx, o.Key); e != nil {
			return e
		}
		if _, e = s.DB.Pool.Exec(ctx, `SELECT finish_garbage_object($1)`, o.ID); e != nil {
			return e
		}
	}
	return nil
}
