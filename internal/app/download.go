package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
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

func (s *Service) download(ctx context.Context, t store.Task) error {
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
	var cacheKey, cacheScope string
	e = s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT cache_key,data_scope FROM assets WHERE id=$1`, t.ID).Scan(&cacheKey, &cacheScope)
	})
	if e != nil {
		return e
	}
	if cacheKey != "" {
		e = c.QueryRow(ctx, `SELECT pg_try_advisory_lock(hashtext($1),-2)`, cacheScope+cacheKey).Scan(&ok)
		if e != nil {
			return e
		}
		if !ok {
			return river.JobSnooze(time.Second)
		}
		defer func() {
			unlockCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if _, err := c.Exec(unlockCtx, `SELECT pg_advisory_unlock(hashtext($1),-2)`, cacheScope+cacheKey); err != nil {
				c.Conn().Close(unlockCtx)
			}
		}()
		hit, err := s.reuseMedia(ctx, t, cacheScope, cacheKey)
		if err != nil || hit {
			return err
		}
	}
	var kind, source, state, key, cid, oid, visibility, dataScope string
	var reserved int64
	e = s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
		if e := lockTenant(ctx, tx, t.Tenant); e != nil {
			return e
		}
		var objectID *string
		e := tx.QueryRow(ctx, `SELECT kind,source_url,state,reserved_bytes,capture_id,object_id,visibility,data_scope FROM assets WHERE id=$1 FOR UPDATE`, t.ID).Scan(&kind, &source, &state, &reserved, &cid, &objectID, &visibility, &dataScope)
		if e != nil {
			return e
		}
		if state != "pending" {
			return nil
		}
		if reserved == 0 {
			var available int64
			if e = tx.QueryRow(ctx, `SELECT quota_bytes-tenant_usage()-reserved_bytes FROM tenants WHERE id=$1`, t.Tenant).Scan(&available); e != nil {
				return e
			}
			limit := s.Config.MaxImageBytes
			if kind == "video" {
				limit = s.Config.MaxVideoBytes
			}
			reserved = min(available, limit)
			if reserved <= 0 {
				return domain.ErrQuota
			}
			if _, e = tx.Exec(ctx, `UPDATE tenants SET reserved_bytes=reserved_bytes+$2 WHERE id=$1`, t.Tenant, reserved); e != nil {
				return e
			}
			if _, e = tx.Exec(ctx, `UPDATE assets SET reserved_bytes=$2 WHERE id=$1`, t.ID, reserved); e != nil {
				return e
			}
		}
		if objectID == nil {
			oid = uuid.NewString()
			key = t.Tenant + "/objects/" + oid
			if _, e = tx.Exec(ctx, `INSERT INTO objects(id,tenant_id,object_key) VALUES($1,$2,$3)`, oid, t.Tenant, key); e != nil {
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
	req, e := http.NewRequestWithContext(ctx, "GET", source, nil)
	if e != nil {
		return &PermanentError{"invalid media URL"}
	}
	resp, e := s.HTTP.Do(req)
	if e != nil {
		return fmt.Errorf("media request failed")
	}
	defer resp.Body.Close()
	if resp.StatusCode == 429 || resp.StatusCode >= 500 {
		return &RetryError{After: parseRetry(resp.Header.Get("Retry-After")), Err: fmt.Errorf("media upstream unavailable")}
	}
	if resp.StatusCode != 200 {
		return &PermanentError{"media provider rejected request"}
	}
	if resp.ContentLength > reserved {
		return &PermanentError{"media exceeds size or remaining storage limit"}
	}
	f, e := os.CreateTemp("", "monitor-media-*")
	if e != nil {
		return e
	}
	defer os.Remove(f.Name())
	defer f.Close()
	h := sha256.New()
	n, e := io.Copy(io.MultiWriter(f, h), io.LimitReader(resp.Body, reserved+1))
	if e != nil {
		return fmt.Errorf("media download interrupted")
	}
	if n > reserved {
		return &PermanentError{"media exceeds size or remaining storage limit"}
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
	if e = s.Blobs.Put(ctx, key, f, n, mime); e != nil {
		return fmt.Errorf("object upload failed")
	}
	digest := hex.EncodeToString(h.Sum(nil))
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
		var bid, bkey string
		// The shared hash lock avoids updates to another tenant's immutable Blob row.
		if _, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,2))`, dataScope+"|"+digest); e != nil {
			return e
		}
		e := tx.QueryRow(ctx, `SELECT id,object_key FROM blobs WHERE data_scope=$1 AND hash=$2`, dataScope, digest).Scan(&bid, &bkey)
		if errors.Is(e, pgx.ErrNoRows) {
			e = tx.QueryRow(ctx, `INSERT INTO blobs(tenant_id,visibility,hash,object_key,size,mime) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,object_key`, t.Tenant, visibility, digest, key, n, mime).Scan(&bid, &bkey)
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
          JOIN tenant_archives ta ON ta.archive_id=r.archive_id JOIN blobs b ON b.id=a.blob_id WHERE b.hash=$1
          UNION ALL SELECT FROM assets a JOIN blobs b ON b.id=a.blob_id WHERE a.capture_id=$2 AND b.hash=$1 AND a.state='ready'
        )`, digest, cid).Scan(&alreadyCounted)
		if e != nil {
			return e
		}
		if alreadyCounted {
			charge = 0
		}
		if _, e = tx.Exec(ctx, `UPDATE tenants SET reserved_bytes=reserved_bytes-$3+$2 WHERE id=$1`, t.Tenant, charge, reserved); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, `UPDATE objects SET state=$2 WHERE id=$1 AND state='pending'`, oid, objectState); e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, `UPDATE assets SET state='ready',blob_id=$2,reserved_bytes=$3 WHERE id=$1`, t.ID, bid, charge); e != nil {
			return e
		}
		return s.Enqueue(ctx, tx, t.Tenant, cid, "finalize")
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
func (s *Service) Collect(ctx context.Context, tenant string, grace time.Duration) error {
	type obj struct{ ID, Key string }
	var list []obj
	e := s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		rows, e := tx.Query(ctx, `UPDATE objects SET state='deleting' WHERE id IN(SELECT id FROM objects WHERE state IN('garbage','deleting') AND created_at < now()-$1::interval ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED) RETURNING id,object_key`, fmt.Sprintf("%f seconds", grace.Seconds()))
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var o obj
			if e = rows.Scan(&o.ID, &o.Key); e != nil {
				return e
			}
			list = append(list, o)
		}
		return rows.Err()
	})
	if e != nil {
		return e
	}
	for _, o := range list {
		if e = s.Blobs.Delete(ctx, o.Key); e != nil {
			return e
		}
		if e = s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
			_, e := tx.Exec(ctx, `UPDATE assets SET object_id=NULL WHERE object_id=$1`, o.ID)
			if e != nil {
				return e
			}
			_, e = tx.Exec(ctx, `DELETE FROM objects WHERE id=$1 AND state='deleting'`, o.ID)
			return e
		}); e != nil {
			return e
		}
	}
	return nil
}
