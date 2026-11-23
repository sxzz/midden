import { failDownload, runDownload } from './download.ts'
import { safeError } from './errors.ts'
import { runCapture } from './fetch.ts'
import { runFinalize } from './finalize.ts'
import { failCapture } from './lifecycle.ts'
import { failThumbnail, runThumbnail } from './thumbnail.ts'
import type { Job, JobHandler } from '#jobs/queue.ts'
import type { CaptureContext } from './context.ts'

/** Job handlers of the capture pipeline, by job type. */
export function captureHandlers(
  context: () => CaptureContext,
): Record<string, JobHandler> {
  const failCaptureJob = (job: Job, error: unknown) => {
    const ctx = context()
    ctx.db.transaction((tx) => failCapture(ctx, tx, job.ref, safeError(error)))
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
