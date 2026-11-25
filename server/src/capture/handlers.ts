import { eq } from 'drizzle-orm'
import { collections } from '#db/schema.ts'
import { failRawUpload, RAW_ATTEMPTS, runRawUpload } from '#raw/upload.ts'
import { failDownload, runDownload } from './download.ts'
import { errorCode, safeError } from './errors.ts'
import { runCapture } from './fetch.ts'
import { runFinalize } from './finalize.ts'
import { failCapture, isActive, loadCapture } from './lifecycle.ts'
import { failRelated, runRelated } from './related.ts'
import { failRelations, runRelations } from './relations.ts'
import { runSourceCheck } from './source-state.ts'
import { failThumbnail, runThumbnail } from './thumbnail.ts'
import { failUpdate, runUpdate } from './updates.ts'
import { failUpload, runUpload, UPLOAD_ATTEMPTS } from './upload.ts'
import type { Job, JobHandler } from '#jobs/queue.ts'
import type { CaptureContext } from './context.ts'

/** Job handlers of the capture pipeline, by job type. */
export function captureHandlers(
  context: () => CaptureContext,
): Record<string, JobHandler> {
  const failCaptureJob = (job: Job, error: unknown) => {
    const ctx = context()
    const message = safeError(error)
    const capture = ctx.db.transaction((tx) => {
      const before = loadCapture(tx, job.ref)
      failCapture(ctx, tx, job.ref, message)
      return before && isActive(before) ? before : undefined
    })
    if (!capture) return
    // The record keeps only the user-facing message, and a retry is a new
    // record: this line ties the failure to its target for later.
    const collection = ctx.db
      .select()
      .from(collections)
      .where(eq(collections.id, capture.collectionId))
      .get()
    ctx.logger.error(
      {
        captureId: capture.id,
        jobId: job.id,
        jobType: job.type,
        attempt: job.attempt,
        maxAttempts: job.maxAttempts,
        state: 'failed',
        errorCode: errorCode(error),
        errorMessage: message,
        providerId: capture.providerId,
        connectionId: capture.connectionId,
        platform: collection?.platform,
        target: collection && {
          kind: collection.kind,
          externalId: collection.externalId,
          url: collection.url,
        },
        durationMs: (ctx.now?.() ?? Date.now()) - capture.createdAt.getTime(),
      },
      'capture failed',
    )
  }
  return {
    capture: {
      queue: 'capture',
      run: (job) => runCapture(context(), job),
      fail: failCaptureJob,
    },
    download: {
      queue: 'download',
      run: (job) => runDownload(context(), job),
      fail: (job, error) => failDownload(context(), job.ref, safeError(error)),
    },
    thumbnail: {
      // Shares the download workers but yields to media someone waits for.
      queue: 'download',
      priority: 4,
      run: (job) => runThumbnail(context(), job),
      fail: (job, error) => failThumbnail(context(), job.ref, safeError(error)),
    },
    // Copies a new blob to the remote media store, if there is one.
    upload: {
      queue: 'upload',
      maxAttempts: UPLOAD_ATTEMPTS,
      run: (job) => runUpload(context(), job),
      fail: (job, error) => failUpload(context(), job.ref, error),
    },
    // Moves a finished capture's raw responses to the raw bucket, if any.
    'raw-upload': {
      queue: 'raw',
      maxAttempts: RAW_ATTEMPTS,
      run: (job) => runRawUpload(context(), job),
      fail: (job, error) => failRawUpload(context(), job.ref, error),
    },
    // Pages of an account's following or followers list, read with the
    // account like a capture.
    relations: {
      queue: 'capture',
      // Rate limits can take a few windows to clear; each run of pages is a
      // new job, so these are per run.
      maxAttempts: 5,
      run: (job) => runRelations(context(), job),
      fail: (job, error) => failRelations(context(), job.ref, safeError(error)),
    },
    related: {
      queue: 'control',
      run: (job) => runRelated(context(), job),
      fail: (job, error) => failRelated(context(), job.ref, safeError(error)),
    },
    // Feeds an update's items to the capture queue a few at a time.
    update: {
      queue: 'control',
      run: (job) => {
        runUpdate(context(), job)
        return Promise.resolve()
      },
      fail: (job, error) => failUpdate(context(), job.ref, safeError(error)),
    },
    // Asks again about content first found gone, an hour later.
    'source-check': {
      queue: 'control',
      run: (job) => {
        runSourceCheck(context(), job)
        return Promise.resolve()
      },
    },
    finalize: {
      queue: 'control',
      run: (job) => {
        runFinalize(context(), job)
        return Promise.resolve()
      },
      fail: failCaptureJob,
    },
  }
}
