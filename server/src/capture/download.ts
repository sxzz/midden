import { Buffer } from 'node:buffer'
import { randomUUIDv7 } from 'node:crypto'
import { open } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { and, eq, ne } from 'drizzle-orm'
import { KeyedLock } from '#blob/locks.ts'
import { stage, type StagedFile } from '#blob/staging.ts'
import {
  assets,
  blobs,
  blobThumbnails,
  captures,
  mediaGarbage,
} from '#db/schema.ts'
import {
  PermanentError,
  RetryError,
  SnoozeError,
  type Job,
} from '#jobs/queue.ts'
import { finalizeSettled, validateExecution } from './lifecycle.ts'
import { acceptsMediaType, sniffMediaType } from './media-type.ts'
import { thumbnailsEnabled } from './thumbnail.ts'
import type { Transaction } from '#db/client.ts'
import type { CaptureContext } from './context.ts'

const REQUEST_TIMEOUT = 5 * 60_000
const CACHE_WAIT = 2000
const SECONDS = /^\d+$/
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

/** A ready asset makes its blob's thumbnail due. */
export function enqueueThumbnail(
  ctx: CaptureContext,
  tx: Transaction,
  blobId: string,
): void {
  if (!thumbnailsEnabled(ctx)) return
  const done = tx
    .select({ id: blobThumbnails.blobId })
    .from(blobThumbnails)
    .where(eq(blobThumbnails.blobId, blobId))
    .get()
  if (!done) ctx.queue.enqueue(tx, 'thumbnail', blobId)
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
  enqueueThumbnail(ctx, tx, blobId)
  finalizeSettled(ctx, tx, asset.captureId)
}

/**
 * Reuse a blob another capture stored for the same rendition (immutable
 * key). Returns whether the asset is settled.
 */
function reuseMedia(ctx: CaptureContext, assetId: string): boolean {
  return ctx.db.transaction((tx) => {
    const row = loadAsset(tx, assetId)
    if (row?.asset.state !== 'pending') return true
    validateExecution(tx, row.capture)
    const cached = tx
      .select({ blobId: assets.blobId })
      .from(assets)
      .where(
        and(
          eq(assets.cacheKey, row.asset.cacheKey),
          eq(assets.state, 'ready'),
          // Spelled out so SQLite can use the partial index `assets_cache`.
          ne(assets.cacheKey, ''),
        ),
      )
      .get()
    if (!cached?.blobId) return false
    attach(ctx, tx, row.asset, cached.blobId)
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

function retryAfterMs(header: string | null): number {
  if (!header) return 0
  if (SECONDS.test(header)) return Number(header) * 1000
  const at = Date.parse(header)
  return Number.isNaN(at) ? 0 : Math.max(at - Date.now(), 0)
}

/** Download one asset into the media store. */
export async function runDownload(
  ctx: CaptureContext,
  job: Job,
): Promise<void> {
  if (assetLocks.isHeld(job.ref)) throw new SnoozeError(1000)
  await assetLocks.run(job.ref, async () => {
    const row = ctx.db.transaction((tx) => loadAsset(tx, job.ref))
    if (row?.asset.state !== 'pending') return
    const { cacheKey } = row.asset
    if (!cacheKey) return download(ctx, job)
    // Identical renditions wait for the first download instead of repeating it.
    if (!(await waitFor(cacheLocks, cacheKey))) throw new SnoozeError(1000)
    await cacheLocks.run(cacheKey, async () => {
      if (!reuseMedia(ctx, job.ref)) await download(ctx, job)
    })
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
  let url: URL
  try {
    url = new URL(asset.sourceUrl)
  } catch {
    throw new PermanentError('invalid media URL')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new PermanentError('invalid media URL')

  const signal = AbortSignal.any([
    job.signal,
    AbortSignal.timeout(REQUEST_TIMEOUT),
  ])
  let response: Response
  try {
    response = await (ctx.fetch ?? fetch)(url, { signal })
  } catch (error) {
    throw new Error(`media request failed: ${(error as Error).message}`, {
      cause: error,
    })
  }
  if (response.status === 429 || response.status >= 500) {
    await response.body?.cancel()
    const after = retryAfterMs(response.headers.get('retry-after'))
    if (after > 0) throw new RetryError('media upstream unavailable', after)
    throw new Error('media upstream unavailable')
  }
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel()
    throw new PermanentError('media provider rejected request')
  }

  let staged: StagedFile
  try {
    staged = await stage(ctx.stagingDir, Readable.fromWeb(response.body), {
      signal,
    })
  } catch (error) {
    throw new Error('media download interrupted', { cause: error })
  }
  try {
    if (staged.size === 0) throw new PermanentError('empty media')
    const mime = sniffMediaType(await readHead(staged.path))
    if (!acceptsMediaType(asset.kind, mime))
      throw new PermanentError('unsupported media format')
    await ctx.mediaLocks.run(staged.hash, async () => {
      // Claim the key back from garbage collection before writing it.
      ctx.db.delete(mediaGarbage).where(eq(mediaGarbage.key, staged.hash)).run()
      await ctx.blobs.putFile(staged.hash, staged.path)
      ctx.db.transaction((tx) => {
        const current = loadAsset(tx, asset.id)
        if (current?.asset.state !== 'pending') return
        validateExecution(tx, current.capture)
        let blobId = tx
          .select({ id: blobs.id })
          .from(blobs)
          .where(eq(blobs.hash, staged.hash))
          .get()?.id
        if (!blobId) {
          blobId = randomUUIDv7()
          tx.insert(blobs)
            .values({ id: blobId, hash: staged.hash, size: staged.size, mime })
            .run()
        }
        attach(ctx, tx, current.asset, blobId)
      })
    })
  } finally {
    await staged.discard()
  }
}

async function readHead(file: string): Promise<Buffer> {
  const handle = await open(file, 'r')
  try {
    const head = Buffer.alloc(512)
    const { bytesRead } = await handle.read(head, 0, 512, 0)
    return head.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/** A download failed for good: settle the asset as failed. */
export function failDownload(
  ctx: CaptureContext,
  assetId: string,
  message: string,
): void {
  ctx.db.transaction((tx) => {
    const row = loadAsset(tx, assetId)
    if (row?.asset.state !== 'pending') return
    tx.update(assets)
      .set({ state: 'failed', error: message })
      .where(eq(assets.id, assetId))
      .run()
    finalizeSettled(ctx, tx, row.asset.captureId)
  })
}
