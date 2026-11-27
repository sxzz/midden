import { and, eq, isNull, sql } from 'drizzle-orm'
import { isNotFound } from '#blob/store.ts'
import {
  blobs,
  blobThumbnails,
  mediaGarbage,
  removedMedia,
} from '#db/schema.ts'
import { pace, type CaptureContext } from './context.ts'

// Thumbnails live in the remote store (R2) like originals: new ones are
// streamed straight into it (`BlobStore.receive`). Those stored only
// locally before are moved by a maintenance step, `moveThumbnails`: once
// an upload is confirmed the web gets the public URL and the local file
// goes.

const BATCH = 50
const CONCURRENCY = 4
/** How long one maintenance pass keeps moving, batch after batch. */
const BUDGET = 20_000
/** After a sweep found nothing (or only what failed), when to look again. */
const SWEEP_AGAIN = 60 * 60_000

const now = (ctx: CaptureContext) => ctx.now?.() ?? Date.now()

/**
 * Record a thumbnail file as being in the remote store, for every
 * thumbnail and removal mark naming it. False when nothing names it any
 * more (collected meanwhile): its object is then garbage too.
 */
function record(ctx: CaptureContext, key: string): boolean {
  const at = new Date(now(ctx))
  return ctx.db.transaction((tx) => {
    tx.update(blobThumbnails)
      .set({ remoteAt: at })
      .where(and(eq(blobThumbnails.key, key), isNull(blobThumbnails.remoteAt)))
      .run()
    tx.update(removedMedia)
      .set({ thumbnailRemoteAt: at })
      .where(
        and(
          eq(removedMedia.thumbnailKey, key),
          isNull(removedMedia.thumbnailRemoteAt),
        ),
      )
      .run()
    const named =
      !!tx
        .select({ id: blobThumbnails.blobId })
        .from(blobThumbnails)
        .where(eq(blobThumbnails.key, key))
        .get() ||
      !!tx
        .select({ id: removedMedia.mediaKey })
        .from(removedMedia)
        .where(eq(removedMedia.thumbnailKey, key))
        .get()
    if (!named)
      tx.insert(mediaGarbage).values({ key }).onConflictDoNothing().run()
    return named
  })
}

/**
 * Delete the local file of a thumbnail now in the remote store, under the
 * media lock of its key, unless the same bytes are also an original still
 * waiting for its own upload.
 */
async function deleteLocal(ctx: CaptureContext, key: string): Promise<void> {
  await ctx.mediaLocks.run(key, async () => {
    const original = ctx.db
      .select({ id: blobs.id })
      .from(blobs)
      .where(and(eq(blobs.hash, key), isNull(blobs.remoteAt)))
      .get()
    if (!original) await ctx.blobs.deleteLocal?.(key)
  })
}

/**
 * Move one thumbnail file to the remote store: upload it (or keep the
 * object already there when it holds the same bytes), record it, delete
 * the local file. False when the store has no remote side or nothing
 * names the thumbnail any more; rejects when the upload fails.
 */
export async function moveThumbnail(
  ctx: CaptureContext,
  key: string,
  contentType: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!ctx.blobs.upload) return false
  await ctx.blobs.upload(key, contentType, signal)
  if (!record(ctx, key)) return false
  await deleteLocal(ctx, key)
  return true
}

interface Sweep {
  /** The last key a pass got to: the next starts after it. */
  after: string
  restUntil: number
}
const sweeps = new WeakMap<CaptureContext, Sweep>()

/**
 * Move thumbnails that are still only local to the remote store, in key
 * order, a batch at a time, for up to `BUDGET` per pass. Each pass
 * continues where the last stopped, and the records make it resumable
 * across restarts: a moved thumbnail is never read again. It stops when
 * the worker gets other work (`idle`). One that fails
 * (a missing file, an upload error) is passed over until the next sweep,
 * an hour after this one ends.
 */
export async function moveThumbnails(
  ctx: CaptureContext,
  idle: () => boolean = () => true,
): Promise<number> {
  if (!ctx.blobs.upload) return 0
  const sweep = sweeps.get(ctx) ?? { after: '', restUntil: 0 }
  sweeps.set(ctx, sweep)
  if (now(ctx) < sweep.restUntil) return 0
  const started = Date.now()
  let moved = 0
  // Only while the worker has nothing else to do, and paced by its throttle.
  while (Date.now() - started < BUDGET && idle()) {
    const rows = ctx.db.all<{ key: string; mime: string }>(sql`
      SELECT key, max(mime) AS mime FROM (
        SELECT ${blobThumbnails.key} AS key, ${blobThumbnails.mime} AS mime
        FROM ${blobThumbnails}
        WHERE ${blobThumbnails.key} IS NOT NULL
          AND ${blobThumbnails.remoteAt} IS NULL
          AND ${blobThumbnails.key} > ${sweep.after}
        UNION ALL
        SELECT ${removedMedia.thumbnailKey}, ${removedMedia.thumbnailMime}
        FROM ${removedMedia}
        WHERE ${removedMedia.thumbnailKey} IS NOT NULL
          AND ${removedMedia.thumbnailRemoteAt} IS NULL
          AND ${removedMedia.thumbnailKey} > ${sweep.after})
      GROUP BY key ORDER BY key LIMIT ${BATCH}`)
    if (!rows.length) {
      sweep.after = ''
      sweep.restUntil = now(ctx) + SWEEP_AGAIN
      break
    }
    for (let i = 0; i < rows.length; i += CONCURRENCY)
      await Promise.all(
        rows.slice(i, i + CONCURRENCY).map(async ({ key, mime }) => {
          try {
            if (await moveThumbnail(ctx, key, mime || 'image/webp')) moved++
          } catch (error) {
            ctx.logger.warn(
              { err: error, key, missing: isNotFound(error) },
              'moving a thumbnail to the remote store failed',
            )
          }
        }),
      )
    sweep.after = rows.at(-1)!.key
    // Batch after batch would keep the write lock from the web process.
    await pace(ctx)
  }
  if (moved) ctx.logger.info({ moved }, 'moved thumbnails to the remote store')
  return moved
}
