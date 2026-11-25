import { and, eq, isNull } from 'drizzle-orm'
import { CorruptBlobError } from '#blob/bucket-store.ts'
import { isNotFound } from '#blob/store.ts'
import { blobs } from '#db/schema.ts'
import { PermanentError, RetryError, type Job } from '#jobs/queue.ts'
import type { Transaction } from '#db/client.ts'
import type { CaptureContext } from './context.ts'

// Out of attempts after about seven hours; `media-migrate` uploads what is
// left over.
export const UPLOAD_ATTEMPTS = 12
const FIRST_RETRY = 30_000
const LONGEST_RETRY = 60 * 60_000

/** A new blob is uploaded once its file is in the local store. */
export function enqueueUpload(
  ctx: CaptureContext,
  tx: Transaction,
  blobId: string,
): void {
  if (ctx.blobs.upload) ctx.queue.enqueue(tx, 'upload', blobId)
}

/**
 * Copy a blob to the remote store, then record it there: from then on the
 * web gets its public URL. The local file stays.
 */
export async function runUpload(ctx: CaptureContext, job: Job): Promise<void> {
  if (!ctx.blobs.upload) return
  const blob = ctx.db.select().from(blobs).where(eq(blobs.id, job.ref)).get()
  if (!blob || blob.remoteAt) return
  try {
    await ctx.blobs.upload(blob.hash, blob.mime, job.signal)
  } catch (error) {
    if (job.signal.aborted) throw error
    if (error instanceof CorruptBlobError || isNotFound(error))
      throw new PermanentError(String(error), { cause: error })
    const delay = Math.min(FIRST_RETRY * 2 ** (job.attempt - 1), LONGEST_RETRY)
    throw new RetryError(`media upload failed: ${String(error)}`, delay, {
      cause: error,
    })
  }
  // A blob released meanwhile is garbage; collecting it deletes the object.
  ctx.db
    .update(blobs)
    .set({ remoteAt: new Date(ctx.now?.() ?? Date.now()) })
    .where(and(eq(blobs.id, blob.id), isNull(blobs.remoteAt)))
    .run()
}

export function failUpload(
  ctx: CaptureContext,
  blobId: string,
  error: unknown,
): void {
  const blob = ctx.db.select().from(blobs).where(eq(blobs.id, blobId)).get()
  ctx.logger.error(
    { blobId, hash: blob?.hash, err: error },
    'media upload gave up; the file stays local',
  )
}
