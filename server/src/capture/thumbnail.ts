import { execFile } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { eq } from 'drizzle-orm'
import { stage } from '#blob/staging.ts'
import { blobs, blobThumbnails, mediaGarbage } from '#db/schema.ts'
import type { Job } from '#jobs/queue.ts'
import type { CaptureContext, Thumbnailer } from './context.ts'

const run = promisify(execFile)
const RENDER_TIMEOUT = 60_000
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

/** Render one blob's thumbnail. A render failure is final, not retried. */
export async function runThumbnail(
  ctx: CaptureContext,
  job: Job,
): Promise<void> {
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
  if (!SOURCE_TYPES.has(blob.mime)) {
    record(ctx, blob.id, { state: 'failed', error: '不支持的媒体格式' })
    return
  }
  await mkdir(ctx.stagingDir, { recursive: true })
  const dir = await mkdtemp(path.join(ctx.stagingDir, 'thumbnail-'))
  try {
    const source = path.join(dir, 'source')
    await pipeline(await ctx.blobs.read(blob.hash), createWriteStream(source))
    const output = path.join(dir, 'thumbnail')
    const encode =
      thumbnailer.encoder === 'libwebp'
        ? ['-c:v', 'libwebp', '-quality', '75', '-f', 'webp']
        : ['-c:v', 'mjpeg', '-q:v', '5', '-pix_fmt', 'yuvj420p', '-f', 'image2']
    try {
      await run(
        thumbnailer.ffmpeg,
        [
          '-nostdin',
          '-v',
          'error',
          '-y',
          '-i',
          source,
          '-map',
          '0:v:0',
          '-frames:v',
          '1',
          '-vf',
          SCALE,
          ...encode,
          output,
        ],
        { timeout: RENDER_TIMEOUT, signal: job.signal },
      )
    } catch {
      if (job.signal.aborted) throw new Error('thumbnail rendering interrupted')
      record(ctx, blob.id, {
        state: 'failed',
        error: 'thumbnail rendering failed',
      })
      return
    }
    const staged = await stage(ctx.stagingDir, createReadStream(output))
    if (staged.size === 0) {
      await staged.discard()
      record(ctx, blob.id, {
        state: 'failed',
        error: 'thumbnail rendering failed',
      })
      return
    }
    const mime = thumbnailer.encoder === 'libwebp' ? 'image/webp' : 'image/jpeg'
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
    await rm(dir, { recursive: true, force: true })
  }
}

/** Record a thumbnail that kept failing, so it is not attempted again. */
export function failThumbnail(
  ctx: CaptureContext,
  blobId: string,
  message: string,
): void {
  record(ctx, blobId, { state: 'failed', error: message })
}
