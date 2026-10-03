package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"monitor/internal/domain"
	"monitor/internal/store"
)

const (
	// Enough for a list tile, an album cell or an avatar on a 3x screen.
	thumbnailShortSide = 400
	thumbnailLongSide  = 1200
	// Per maintenance run. A task takes about a tenth of a second and the
	// download workers run them in parallel, so this is cleared well within a run.
	thumbnailBackfill = 2000
)

// thumbnailEncoder prefers WebP and falls back to JPEG where ffmpeg was built
// without libwebp. Empty when ffmpeg itself is missing.
var thumbnailEncoder = sync.OnceValue(func() string {
	if _, e := exec.LookPath("ffmpeg"); e != nil {
		return ""
	}
	if out, _ := exec.Command("ffmpeg", "-hide_banner", "-h", "encoder=libwebp").Output(); strings.Contains(string(out), "Encoder libwebp") {
		return "libwebp"
	}
	return "mjpeg"
})

// thumbnailable lists the stored formats ffmpeg turns into a still image.
func thumbnailable(mime string) bool {
	switch mime {
	case "image/jpeg", "image/png", "image/webp", "video/mp4", "video/webm":
		return true
	}
	return false
}

// enqueueThumbnail asks for a blob's thumbnail unless one was already made or
// given up on. Duplicate tasks are harmless: the task checks again under a lock.
func (s *Service) enqueueThumbnail(ctx context.Context, tx pgx.Tx, tenant, blob string) error {
	var wanted bool
	if e := tx.QueryRow(ctx, `SELECT NOT EXISTS(SELECT FROM blob_thumbnails WHERE blob_id=$1) FROM blobs WHERE id=$1`, blob).Scan(&wanted); e != nil {
		return e
	}
	// Without ffmpeg nothing is recorded, so a later build can still make them.
	if !wanted || thumbnailEncoder() == "" {
		return nil
	}
	return s.Enqueue(ctx, tx, tenant, blob, "thumbnail")
}

// backfillThumbnails covers blobs stored before thumbnails existed, a batch
// per maintenance run.
func (s *Service) backfillThumbnails(ctx context.Context) error {
	if thumbnailEncoder() == "" {
		return nil
	}
	rows, e := s.DB.Pool.Query(ctx, `SELECT blob_id,tenant_id FROM blobs_missing_thumbnails($1) m WHERE NOT EXISTS(SELECT FROM river_job j WHERE j.kind='monitor_task' AND j.state IN('available','running','retryable','scheduled') AND j.args->>'type'='thumbnail' AND j.args->>'id'=m.blob_id::text)`, thumbnailBackfill)
	if e != nil {
		return e
	}
	tasks, e := pgx.CollectRows(rows, func(row pgx.CollectableRow) (t store.Task, e error) {
		t.Type = "thumbnail"
		e = row.Scan(&t.ID, &t.Tenant)
		return
	})
	if e != nil {
		return e
	}
	for _, t := range tasks {
		if e = s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error { return s.Enqueue(ctx, tx, t.Tenant, t.ID, t.Type) }); e != nil {
			return e
		}
	}
	return nil
}

func failThumbnail(ctx context.Context, tx pgx.Tx, blob, msg string) error {
	_, e := tx.Exec(ctx, `INSERT INTO blob_thumbnails(blob_id,state,error) SELECT id,'failed',$2 FROM blobs WHERE id=$1 ON CONFLICT DO NOTHING`, blob, msg)
	return e
}

// thumbnail derives one small WebP from a stored blob. The task ID is the blob.
func (s *Service) thumbnail(ctx context.Context, t store.Task) error {
	c, e := s.DB.Pool.Acquire(ctx)
	if e != nil {
		return e
	}
	defer c.Release()
	// One tenant's task makes the thumbnail every tenant then shares.
	if _, e = c.Exec(ctx, `SELECT pg_advisory_lock(hashtextextended($1,3))`, t.ID); e != nil {
		return e
	}
	defer func() {
		unlockCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := c.Exec(unlockCtx, `SELECT pg_advisory_unlock(hashtextextended($1,3))`, t.ID); err != nil {
			c.Conn().Close(unlockCtx)
		}
	}()
	var key, mime string
	var done bool
	e = s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT object_key,mime,EXISTS(SELECT FROM blob_thumbnails WHERE blob_id=$1) FROM blobs WHERE id=$1`, t.ID).Scan(&key, &mime, &done)
	})
	// The blob may have been collected since the task was queued.
	if errors.Is(e, domain.ErrNotFound) || done {
		return nil
	}
	if e != nil {
		return e
	}
	giveUp := func(msg string) error {
		return s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error { return failThumbnail(ctx, tx, t.ID, msg) })
	}
	if !thumbnailable(mime) {
		return giveUp("unsupported media format")
	}
	encoder := thumbnailEncoder()
	if encoder == "" {
		return nil
	}
	dir, e := os.MkdirTemp("", "thumbnail-*")
	if e != nil {
		return e
	}
	defer os.RemoveAll(dir)
	source := filepath.Join(dir, "source")
	if e = s.fetchBlob(ctx, key, source); e != nil {
		return e
	}
	out := filepath.Join(dir, "thumbnail")
	mime, e = renderThumbnail(ctx, encoder, source, out)
	if e != nil {
		// The file itself cannot be rendered; another attempt would not either.
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return giveUp("thumbnail rendering failed")
	}
	f, e := os.Open(out)
	if e != nil {
		return e
	}
	defer f.Close()
	info, e := f.Stat()
	if e != nil {
		return e
	}
	oid := uuid.NewString()
	object := "objects/" + oid
	// Registered as garbage until attached, so an interrupted task leaves
	// nothing behind that object GC would not collect.
	if e = s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `INSERT INTO objects(id,uploaded_by,object_key,state) VALUES($1,$2,$3,'garbage')`, oid, t.Tenant, object)
		return e
	}); e != nil {
		return e
	}
	if e = s.Blobs.Put(ctx, object, f, info.Size(), mime); e != nil {
		return fmt.Errorf("thumbnail upload failed: %w", e)
	}
	return s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
		// The blob can be collected while its thumbnail is being made.
		tag, e := tx.Exec(ctx, `INSERT INTO blob_thumbnails(blob_id,state,object_key,size,mime) SELECT id,'ready',$2,$3,$4 FROM blobs WHERE id=$1 ON CONFLICT DO NOTHING`, t.ID, object, info.Size(), mime)
		if e != nil {
			return e
		}
		if tag.RowsAffected() == 0 {
			return nil
		}
		tag, e = tx.Exec(ctx, `UPDATE objects SET state='attached' WHERE id=$1 AND state='garbage'`, oid)
		if e == nil && tag.RowsAffected() == 0 {
			return fmt.Errorf("thumbnail object collected before attachment")
		}
		return e
	})
}

func (s *Service) fetchBlob(ctx context.Context, key, path string) error {
	body, e := s.Blobs.Get(ctx, key)
	if e != nil {
		return e
	}
	defer body.Close()
	f, e := os.Create(path)
	if e != nil {
		return e
	}
	if _, e = io.Copy(f, body); e != nil {
		f.Close()
		return e
	}
	return f.Close()
}

// renderThumbnail scales the first frame so its short side is at most
// thumbnailShortSide and its long side at most thumbnailLongSide, never
// enlarging, and reports the MIME type it wrote.
func renderThumbnail(ctx context.Context, encoder, source, out string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	// Scale by the short side first, then cap the long side for extreme ratios.
	scale := fmt.Sprintf("scale='if(gt(iw,ih),-2,min(iw,%[1]d))':'if(gt(iw,ih),min(ih,%[1]d),-2)',scale='min(iw,%[2]d)':'min(ih,%[2]d)':force_original_aspect_ratio=decrease", thumbnailShortSide, thumbnailLongSide)
	args := []string{"-nostdin", "-v", "error", "-y", "-i", source, "-map", "0:v:0", "-frames:v", "1", "-vf", scale}
	mime := "image/webp"
	if encoder == "libwebp" {
		args = append(args, "-c:v", "libwebp", "-quality", "75", "-f", "webp")
	} else {
		mime = "image/jpeg"
		args = append(args, "-c:v", "mjpeg", "-q:v", "5", "-pix_fmt", "yuvj420p", "-f", "image2")
	}
	if e := exec.CommandContext(ctx, "ffmpeg", append(args, out)...).Run(); e != nil {
		return "", e
	}
	if info, e := os.Stat(out); e != nil || info.Size() == 0 {
		return "", fmt.Errorf("empty thumbnail")
	}
	return mime, nil
}
