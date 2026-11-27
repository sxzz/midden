import { and, eq } from 'drizzle-orm'
import { KeyedLock } from '#blob/locks.ts'
import { newId } from '#db/id.ts'
import { assets, blobs, captures, mediaGarbage } from '#db/schema.ts'
import { PermanentError, SnoozeError, type Job } from '#jobs/queue.ts'
import { finalizeSettled, validateExecution } from './lifecycle.ts'
import { fetchMedia, mediaURL } from './media-fetch.ts'
import { isRemoved } from './media-key.ts'
import { cachedBlob, reuseKey } from './media-reuse.ts'
import { acceptsMediaType, sniffMediaType } from './media-type.ts'
import { downloadThumbnail, failThumbnail } from './thumbnail.ts'
import { enqueueUpload } from './upload.ts'
import type { Transaction } from '#db/client.ts'
import type { CaptureContext } from './context.ts'

const REQUEST_TIMEOUT = 5 * 60_000
const CACHE_WAIT = 2000
const assetLocks = new KeyedLock()
const cacheLocks = new KeyedLock()

type Asset = typeof assets.$inferSelect

function loadAsset(tx: Transaction, id: string) {
  return tx
    .select({ asset: assets, capture: captures })
    .from(assets)
    .innerJoin(captures, eq(captures.id, assets.captureId))
    .where(eq(assets.id, id))
    .get()
}

function attach(
  ctx: CaptureContext,
  tx: Transaction,
  asset: Asset,
  blobId: string,
): void {
  tx.update(assets)
    .set({ state: 'ready', blobId, error: '' })
    .where(and(eq(assets.id, asset.id), eq(assets.state, 'pending')))
    .run()
  finalizeSettled(ctx, tx, asset.captureId)
}

/**
 * Reuse a blob another capture stored for the same rendition (immutable
 * key), when it was stored after this asset was listed (`fetch.ts` reuses
 * those stored before). Returns whether the asset is settled.
 */
function reuseMedia(ctx: CaptureContext, assetId: string): boolean {
  return ctx.db.transaction((tx) => {
    const row = loadAsset(tx, assetId)
    if (row?.asset.state !== 'pending') return true
    validateExecution(tx, row.capture)
    const cached = cachedBlob(tx, reuseKey(row.asset))
    if (!cached) return false
    attach(ctx, tx, row.asset, cached)
    return true
  })
}

async function waitFor(lock: KeyedLock, key: string): Promise<boolean> {
  const deadline = Date.now() + CACHE_WAIT
  while (lock.isHeld(key)) {
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return true
}

/**
 * Media the owner removed after this asset was listed (in this collection
 * or another one listing the same media) settles as removed, unfetched.
 */
function skipRemoved(ctx: CaptureContext, assetId: string): boolean {
  return ctx.db.transaction((tx) => {
    const row = loadAsset(tx, assetId)
    if (row?.asset.state !== 'pending') return true
    if (!isRemoved(tx, row.asset.mediaKey)) return false
    tx.update(assets)
      .set({ state: 'removed' })
      .where(and(eq(assets.id, assetId), eq(assets.state, 'pending')))
      .run()
    finalizeSettled(ctx, tx, row.asset.captureId)
    return true
  })
}

/**
 * Download one asset into the media store, then its blob's thumbnail. The
 * asset is ready (and its capture may finish) before the thumbnail is
 * fetched, so a thumbnail that fails fails nothing else: the job is tried
 * again for the thumbnail alone, and `failDownload` records it as failed in
 * the end. A capture finding media stored before without a thumbnail also
 * queues this job, for the thumbnail.
 */
export async function runDownload(
  ctx: CaptureContext,
  job: Job,
): Promise<void> {
  if (assetLocks.isHeld(job.ref)) throw new SnoozeError(1000)
  await assetLocks.run(job.ref, async () => {
    const row = ctx.db.transaction((tx) => loadAsset(tx, job.ref))
    if (row?.asset.state === 'pending') {
      const key = reuseKey(row.asset)
      if (key) {
        // Identical renditions wait for the first download instead of
        // repeating it.
        if (!(await waitFor(cacheLocks, key))) throw new SnoozeError(1000)
        await cacheLocks.run(key, async () => {
          // Checked only now: the media may have been removed while waiting.
          if (skipRemoved(ctx, job.ref)) return
          if (!reuseMedia(ctx, job.ref)) await download(ctx, job)
        })
      } else if (!skipRemoved(ctx, job.ref)) await download(ctx, job)
    }
    await downloadThumbnail(ctx, job.ref, job.signal)
  })
}

async function download(ctx: CaptureContext, job: Job): Promise<void> {
  const row = ctx.db.transaction((tx) => {
    const found = loadAsset(tx, job.ref)
    if (found?.asset.state !== 'pending') return
    validateExecution(tx, found.capture)
    return found
  })
  if (!row) return
  const { asset } = row
  const url = mediaURL(asset.sourceUrl)
  const signal = AbortSignal.any([
    job.signal,
    AbortSignal.timeout(REQUEST_TIMEOUT),
  ])
  const incoming = await fetchMedia(ctx, url, signal)
  try {
    if (incoming.size === 0) throw new PermanentError('媒体文件为空')
    const mime = sniffMediaType(incoming.head)
    if (!acceptsMediaType(asset.kind, mime))
      throw new PermanentError('不支持的媒体格式')
    const { hash } = incoming
    await ctx.mediaLocks.run(hash, async () => {
      // Claim the key back from garbage collection before writing it.
      ctx.db.delete(mediaGarbage).where(eq(mediaGarbage.key, hash)).run()
      // The bucket holds these bytes already: nothing to write. Nothing is
      // awaited from this check on but the write, so the blob is still
      // there when the transaction below attaches it.
      const before = ctx.db
        .select({ remoteAt: blobs.remoteAt })
        .from(blobs)
        .where(eq(blobs.hash, hash))
        .get()
      const remote = before?.remoteAt
        ? true
        : (await incoming.keep(mime)).remote
      const at = new Date(ctx.now?.() ?? Date.now())
      ctx.db.transaction((tx) => {
        const current = loadAsset(tx, asset.id)
        if (current?.asset.state !== 'pending') {
          // Settled meanwhile (removed, say): the file stays only if shared.
          if (!tx.select().from(blobs).where(eq(blobs.hash, hash)).get())
            tx.insert(mediaGarbage)
              .values({ key: hash })
              .onConflictDoNothing()
              .run()
          return
        }
        validateExecution(tx, current.capture)
        const stored = tx
          .select({ id: blobs.id, remoteAt: blobs.remoteAt })
          .from(blobs)
          .where(eq(blobs.hash, hash))
          .get()
        let blobId = stored?.id
        if (!blobId) {
          blobId = newId()
          // Streamed into the bucket and confirmed there: recorded so from
          // the start, with no local copy and no upload to make.
          tx.insert(blobs)
            .values({
              id: blobId,
              hash,
              size: incoming.size,
              mime,
              remoteAt: remote ? at : null,
            })
            .run()
          if (!remote) enqueueUpload(ctx, tx, blobId)
        } else if (remote && !stored?.remoteAt) {
          // A local original from before: the bucket has it now, and the
          // upload job only deletes the local copy.
          tx.update(blobs)
            .set({ remoteAt: at })
            .where(eq(blobs.id, blobId))
            .run()
          enqueueUpload(ctx, tx, blobId)
        }
        attach(ctx, tx, current.asset, blobId)
      })
    })
  } finally {
    await incoming.discard()
  }
}

/**
 * A download failed for good: settle the asset as failed, or, when only its
 * thumbnail was left, record that as failed.
 */
export function failDownload(
  ctx: CaptureContext,
  assetId: string,
  message: string,
): void {
  ctx.db.transaction((tx) => {
    const row = loadAsset(tx, assetId)
    if (row?.asset.state === 'ready' && row.asset.thumbnailUrl)
      failThumbnail(tx, row.asset.blobId, message)
    if (row?.asset.state !== 'pending') return
    tx.update(assets)
      .set({ state: 'failed', error: message })
      .where(eq(assets.id, assetId))
      .run()
    finalizeSettled(ctx, tx, row.asset.captureId)
  })
}
