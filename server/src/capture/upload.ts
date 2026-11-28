import { and, eq, isNull } from 'drizzle-orm'
import { CorruptBlobError } from '#blob/bucket-store.ts'
import { isNotFound } from '#blob/store.ts'
import { blobs } from '#db/schema.ts'
import { PermanentError, RetryError, type Job } from '#jobs/queue.ts'
import type { Executor } from '#db/client.ts'
import type { CaptureContext } from './context.ts'

// Out of attempts after about seven hours; `media-migrate` uploads what is
// left over, `media-prune-local` deletes local copies left over.
export const UPLOAD_ATTEMPTS = 12
const FIRST_RETRY = 30_000
const LONGEST_RETRY = 60 * 60_000

/** A new blob is uploaded once its file is in the local store. */
export function enqueueUpload(
  ctx: CaptureContext,
  executor: Executor,
  blobId: string,
): void {
  if (ctx.blobs.upload) ctx.queue.enqueue(executor, 'upload', blobId)
}

function loadBlob(ctx: CaptureContext, id: string) {
  return ctx.db.select().from(blobs).where(eq(blobs.id, id)).get()
}

function retryDelay(job: Job): number {
  return Math.min(FIRST_RETRY * 2 ** (job.attempt - 1), LONGEST_RETRY)
}

/**
 * Copy a blob to the remote store and record it there: from then on the
 * web gets its public URL. Then delete the local original, which leaves
 * the remote store with the only copy.
 */
export async function runUpload(ctx: CaptureContext, job: Job): Promise<void> {
  if (!ctx.blobs.upload) return
  const blob = loadBlob(ctx, job.ref)
  if (!blob) return
  if (!blob.remoteAt) {
    try {
      await ctx.blobs.upload(blob.hash, blob.mime, job.signal)
    } catch (error) {
      if (job.signal.aborted) throw error
      // `media-migrate` uploaded it meanwhile and deleted the local file.
      if (isNotFound(error) && loadBlob(ctx, blob.id)?.remoteAt) return
      if (error instanceof CorruptBlobError || isNotFound(error))
        throw new PermanentError(String(error), { cause: error })
      throw new RetryError(
        `media upload failed: ${String(error)}`,
        retryDelay(job),
        { cause: error },
      )
    }
    // A blob released meanwhile is garbage; collecting it deletes the object.
    ctx.db
      .update(blobs)
      .set({ remoteAt: new Date(ctx.now?.() ?? Date.now()) })
      .where(and(eq(blobs.id, blob.id), isNull(blobs.remoteAt)))
      .run()
  }
  try {
    await deleteLocalOriginal(ctx, blob.id)
  } catch (error) {
    if (job.signal.aborted) throw error
    // The record stays: the bucket's copy is confirmed either way.
    throw new RetryError(
      `deleting the local copy failed: ${String(error)}`,
      retryDelay(job),
      { cause: error },
    )
  }
}

/**
 * Delete the local original of a blob recorded in the bucket, under the
 * media lock downloads and garbage collection take for its key, and checked
 * again there: a download of the same bytes then finds the blob in the
 * bucket and writes no local copy, and collection finds nothing left to
 * delete locally. Readers already reading the file keep reading it; later
 * ones read the bucket.
 */
async function deleteLocalOriginal(
  ctx: CaptureContext,
  blobId: string,
): Promise<void> {
  const blob = loadBlob(ctx, blobId)
  if (!blob?.remoteAt || !ctx.blobs.deleteLocal) return
  await ctx.mediaLocks.run(blob.hash, async () => {
    const current = loadBlob(ctx, blobId)
    if (!current?.remoteAt) return
    await ctx.blobs.deleteLocal?.(current.hash)
  })
}

export function failUpload(
  ctx: CaptureContext,
  blobId: string,
  error: unknown,
): void {
  const blob = loadBlob(ctx, blobId)
  if (blob?.remoteAt)
    ctx.logger.error(
      { blobId, hash: blob.hash, err: error },
      'deleting the local copy of uploaded media gave up; media-prune-local removes it',
    )
  else
    ctx.logger.error(
      { blobId, hash: blob?.hash, err: error },
      'media upload gave up; the file stays local',
    )
}
