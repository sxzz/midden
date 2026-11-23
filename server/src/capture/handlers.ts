import { safeError } from './errors.ts'
import { runCapture } from './fetch.ts'
import { runFinalize } from './finalize.ts'
import { failCapture } from './lifecycle.ts'
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
