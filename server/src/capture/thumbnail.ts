import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { and, eq } from 'drizzle-orm'
import { stage, type StagedFile } from '#blob/staging.ts'
import { withSource } from '#blob/store.ts'
import {
  blobs,
  blobThumbnails,
  mediaGarbage,
  removedMedia,
} from '#db/schema.ts'
import { thumbnailDone } from './upload.ts'
import type { Job } from '#jobs/queue.ts'
import type { CaptureContext, Thumbnailer } from './context.ts'

const run = promisify(execFile)
const RENDER_TIMEOUT = 60_000
const URL_INPUT = /^https?:/
const SOURCE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'video/mp4',
  'video/webm',
])
// Short side at most 400 and long side at most 1200, never enlarged.
const SCALE =
  "scale='if(gt(iw,ih),-2,min(iw,400))':'if(gt(iw,ih),min(ih,400),-2)',scale='min(iw,1200)':'min(ih,1200)':force_original_aspect_ratio=decrease"

/** Find ffmpeg and its best still-image encoder; undefined without one. */
export async function detectThumbnailer(
  ffmpeg = 'ffmpeg',
): Promise<Thumbnailer | undefined> {
  try {
    const { stdout } = await run(ffmpeg, [
      '-hide_banner',
      '-h',
      'encoder=libwebp',
    ])
    return {
      ffmpeg,
      encoder: stdout.includes('Encoder libwebp') ? 'libwebp' : 'mjpeg',
    }
  } catch {
    return undefined
  }
}

export function thumbnailsEnabled(ctx: CaptureContext): boolean {
  return !!ctx.thumbnailer
}

function record(
  ctx: CaptureContext,
  blobId: string,
  values: Partial<typeof blobThumbnails.$inferInsert> & {
    state: 'ready' | 'failed'
  },
): boolean {
  return ctx.db.transaction((tx) => {
    if (!tx.select().from(blobs).where(eq(blobs.id, blobId)).get()) return false
    return (
      tx
        .insert(blobThumbnails)
        .values({ blobId, ...values })
        .onConflictDoNothing()
        .run().changes > 0
    )
  })
}

type Blob = typeof blobs.$inferSelect

/** ffmpeg could not render the media; trying again would not help. */
class RenderError extends Error {
  override name = 'RenderError'
}

/**
 * Render a blob's thumbnail into a staged file, reading the original where
 * the store has it: the local file, or else ffmpeg fetches only the byte
 * ranges it needs from a presigned URL. Resolves to the reason when the
 * media cannot be rendered; a missing original rejects.
 */
async function render(
  ctx: CaptureContext,
  thumbnailer: Thumbnailer,
  blob: Blob,
  signal: AbortSignal,
): Promise<{ staged: StagedFile; mime: string } | { error: string }> {
  if (!SOURCE_TYPES.has(blob.mime)) return { error: '不支持的媒体格式' }
  await mkdir(ctx.stagingDir, { recursive: true })
  const dir = await mkdtemp(path.join(ctx.stagingDir, 'thumbnail-'))
  try {
    const output = path.join(dir, 'thumbnail')
    const encode =
      thumbnailer.encoder === 'libwebp'
        ? ['-c:v', 'libwebp', '-quality', '75', '-f', 'webp']
        : ['-c:v', 'mjpeg', '-q:v', '5', '-pix_fmt', 'yuvj420p', '-f', 'image2']
    const ffmpeg = async (input: string) => {
      try {
        await run(
          thumbnailer.ffmpeg,
          [
            '-nostdin',
            '-v',
            'error',
            '-y',
            // Give up on a stalled connection (microseconds).
            ...(URL_INPUT.test(input) ? ['-rw_timeout', '30000000'] : []),
            '-i',
            input,
            '-map',
            '0:v:0',
            '-frames:v',
            '1',
            '-vf',
            SCALE,
            ...encode,
            output,
          ],
          { timeout: RENDER_TIMEOUT, signal },
        )
      } catch (error) {
        if (signal.aborted)
          throw new Error('thumbnail rendering interrupted', { cause: error })
        throw new RenderError('thumbnail rendering failed', { cause: error })
      }
    }
    try {
      await withSource(ctx.blobs, blob.hash, ffmpeg)
    } catch (error) {
      if (error instanceof RenderError) return { error: error.message }
      throw error
    }
    const staged = await stage(ctx.stagingDir, createReadStream(output))
    if (staged.size === 0) {
      await staged.discard()
      return { error: 'thumbnail rendering failed' }
    }
    return {
      staged,
      mime: thumbnailer.encoder === 'libwebp' ? 'image/webp' : 'image/jpeg',
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * Render one blob's thumbnail. A render failure is final, not retried.
 * Either way the blob's local original no longer waits for it.
 */
export async function runThumbnail(
  ctx: CaptureContext,
  job: Job,
): Promise<void> {
  await renderThumbnail(ctx, job)
  thumbnailDone(ctx, job.ref)
}

async function renderThumbnail(ctx: CaptureContext, job: Job): Promise<void> {
  const thumbnailer = ctx.thumbnailer
  if (!thumbnailer) return
  const blob = ctx.db.select().from(blobs).where(eq(blobs.id, job.ref)).get()
  if (!blob) return
  const done = ctx.db
    .select()
    .from(blobThumbnails)
    .where(eq(blobThumbnails.blobId, blob.id))
    .get()
  if (done) return
  const result = await render(ctx, thumbnailer, blob, job.signal)
  if ('error' in result) {
    record(ctx, blob.id, { state: 'failed', error: result.error })
    return
  }
  const { staged, mime } = result
  try {
    await ctx.mediaLocks.run(staged.hash, async () => {
      ctx.db.delete(mediaGarbage).where(eq(mediaGarbage.key, staged.hash)).run()
      await ctx.blobs.putFile(staged.hash, staged.path)
      const attached = record(ctx, blob.id, {
        state: 'ready',
        key: staged.hash,
        size: staged.size,
        mime,
      })
      // The blob went away meanwhile; the file is garbage unless shared.
      if (!attached)
        ctx.db
          .insert(mediaGarbage)
          .values({ key: staged.hash })
          .onConflictDoNothing()
          .run()
    })
  } finally {
    await staged.discard()
  }
}

export interface RegeneratedThumbnail {
  key: string
  contentType: string
}

const regenerating = new Map<
  string,
  Promise<RegeneratedThumbnail | undefined>
>()

/**
 * Thumbnails are a local cache: when one's file is missing, render it again
 * from the original, wherever that lives. The bytes may differ from the
 * lost ones (another ffmpeg, say); then the thumbnail is recorded under its
 * new key, which the caller sends the browser to. Undefined when the key is
 * no blob's thumbnail (a removed media item's, whose original is gone) or
 * rendering fails.
 */
export function regenerateThumbnail(
  ctx: CaptureContext,
  key: string,
): Promise<RegeneratedThumbnail | undefined> {
  let pending = regenerating.get(key)
  if (!pending) {
    pending = rerender(ctx, key).finally(() => regenerating.delete(key))
    regenerating.set(key, pending)
  }
  return pending
}

async function rerender(
  ctx: CaptureContext,
  key: string,
): Promise<RegeneratedThumbnail | undefined> {
  const thumbnailer = ctx.thumbnailer
  if (!thumbnailer) return
  const row = ctx.db
    .select({ blob: blobs })
    .from(blobThumbnails)
    .innerJoin(blobs, eq(blobs.id, blobThumbnails.blobId))
    .where(and(eq(blobThumbnails.key, key), eq(blobThumbnails.state, 'ready')))
    .get()
  if (!row) return
  let result: Awaited<ReturnType<typeof render>>
  try {
    result = await render(
      ctx,
      thumbnailer,
      row.blob,
      AbortSignal.timeout(RENDER_TIMEOUT),
    )
  } catch (error) {
    ctx.logger.warn({ err: error, key }, 'thumbnail regeneration failed')
    return
  }
  if ('error' in result) {
    ctx.logger.warn(
      { key, error: result.error },
      'thumbnail regeneration failed',
    )
    return
  }
  const { staged, mime } = result
  try {
    return await ctx.mediaLocks.run(staged.hash, async () => {
      ctx.db.delete(mediaGarbage).where(eq(mediaGarbage.key, staged.hash)).run()
      await ctx.blobs.putFile(staged.hash, staged.path)
      if (staged.hash !== key)
        ctx.db.transaction((tx) => {
          // Whatever showed the lost file shows the new one.
          tx.update(blobThumbnails)
            .set({ key: staged.hash, size: staged.size, mime })
            .where(eq(blobThumbnails.key, key))
            .run()
          tx.update(removedMedia)
            .set({ thumbnailKey: staged.hash, thumbnailMime: mime })
            .where(eq(removedMedia.thumbnailKey, key))
            .run()
          // A stray copy of the old key (in the bucket, say) is collected.
          tx.insert(mediaGarbage).values({ key }).onConflictDoNothing().run()
        })
      ctx.logger.info(
        { key, regenerated: staged.hash },
        'thumbnail regenerated',
      )
      return { key: staged.hash, contentType: mime }
    })
  } finally {
    await staged.discard()
  }
}

/** Record a thumbnail that kept failing, so it is not attempted again. */
export function failThumbnail(
  ctx: CaptureContext,
  blobId: string,
  message: string,
): void {
  record(ctx, blobId, { state: 'failed', error: message })
  thumbnailDone(ctx, blobId)
}
