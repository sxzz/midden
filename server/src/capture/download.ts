import { Buffer } from 'node:buffer'
import { open } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { and, eq } from 'drizzle-orm'
import { KeyedLock } from '#blob/locks.ts'
import { stage, type StagedFile } from '#blob/staging.ts'
import { newId } from '#db/id.ts'
import { assets, blobs, captures, mediaGarbage } from '#db/schema.ts'
import {
  PermanentError,
  RetryError,
  SnoozeError,
  type Job,
} from '#jobs/queue.ts'
import { finalizeSettled, validateExecution } from './lifecycle.ts'
import { isRemoved } from './media-key.ts'
import { cachedBlob, enqueueThumbnail } from './media-reuse.ts'
import { acceptsMediaType, sniffMediaType } from './media-type.ts'
import { enqueueUpload } from './upload.ts'
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
 * key), when it was stored after this asset was listed (`fetch.ts` reuses
 * those stored before). Returns whether the asset is settled.
 */
function reuseMedia(ctx: CaptureContext, assetId: string): boolean {
  return ctx.db.transaction((tx) => {
    const row = loadAsset(tx, assetId)
    if (row?.asset.state !== 'pending') return true
    validateExecution(tx, row.capture)
    const cached = cachedBlob(tx, row.asset.cacheKey)
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

function retryAfterMs(header: string | null): number {
  if (!header) return 0
  if (SECONDS.test(header)) return Number(header) * 1000
  const at = Date.parse(header)
  return Number.isNaN(at) ? 0 : Math.max(at - Date.now(), 0)
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
    if (!cacheKey) {
      if (!skipRemoved(ctx, job.ref)) await download(ctx, job)
      return
    }
    // Identical renditions wait for the first download instead of repeating it.
    if (!(await waitFor(cacheLocks, cacheKey))) throw new SnoozeError(1000)
    await cacheLocks.run(cacheKey, async () => {
      // Checked only now: the media may have been removed while waiting.
      if (skipRemoved(ctx, job.ref)) return
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
    throw new PermanentError('媒体地址无效')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new PermanentError('媒体地址无效')

  const signal = AbortSignal.any([
    job.signal,
    AbortSignal.timeout(REQUEST_TIMEOUT),
  ])
  let response: Response
  try {
    response = await (ctx.fetch ?? fetch)(url, { signal })
  } catch (error) {
    throw new Error(`媒体请求失败：${(error as Error).message}`, {
      cause: error,
    })
  }
  if (response.status === 429 || response.status >= 500) {
    await response.body?.cancel()
    const after = retryAfterMs(response.headers.get('retry-after'))
    if (after > 0) throw new RetryError('媒体服务器暂时不可用', after)
    throw new Error('媒体服务器暂时不可用')
  }
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel()
    throw new PermanentError('媒体服务器拒绝了请求')
  }

  let staged: StagedFile
  try {
    staged = await stage(ctx.stagingDir, Readable.fromWeb(response.body), {
      signal,
    })
  } catch (error) {
    throw new Error('媒体下载被中断', { cause: error })
  }
  try {
    if (staged.size === 0) throw new PermanentError('媒体文件为空')
    const mime = sniffMediaType(await readHead(staged.path))
    if (!acceptsMediaType(asset.kind, mime))
      throw new PermanentError('不支持的媒体格式')
    await ctx.mediaLocks.run(staged.hash, async () => {
      // Claim the key back from garbage collection before writing it.
      ctx.db.delete(mediaGarbage).where(eq(mediaGarbage.key, staged.hash)).run()
      // The bucket holds these bytes already, and they need no local copy
      // (see `upload.ts`). Nothing is awaited from this check on, so the
      // blob is still there when the transaction below attaches it.
      const inBucket =
        !!ctx.blobs.deleteLocal &&
        !!ctx.db
          .select({ remoteAt: blobs.remoteAt })
          .from(blobs)
          .where(eq(blobs.hash, staged.hash))
          .get()?.remoteAt
      if (!inBucket) await ctx.blobs.putFile(staged.hash, staged.path)
      ctx.db.transaction((tx) => {
        const current = loadAsset(tx, asset.id)
        if (current?.asset.state !== 'pending') {
          // Settled meanwhile (removed, say): the file stays only if shared.
          if (!tx.select().from(blobs).where(eq(blobs.hash, staged.hash)).get())
            tx.insert(mediaGarbage)
              .values({ key: staged.hash })
              .onConflictDoNothing()
              .run()
          return
        }
        validateExecution(tx, current.capture)
        let blobId = tx
          .select({ id: blobs.id })
          .from(blobs)
          .where(eq(blobs.hash, staged.hash))
          .get()?.id
        if (!blobId) {
          blobId = newId()
          tx.insert(blobs)
            .values({ id: blobId, hash: staged.hash, size: staged.size, mime })
            .run()
          enqueueUpload(ctx, tx, blobId)
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
