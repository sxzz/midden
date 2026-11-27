import type { QueueStatus } from '#jobs/queue.ts'
import type { ThrottleState } from '#jobs/throttle.ts'

/**
 * What the worker reports about itself, for the admin page (`/v1/queue`).
 * Its own module, of types only: the web app's typecheck reads the API's
 * types, and `worker.ts` would pull in the whole worker.
 */
export interface WorkerReport {
  /** When it was taken, in epoch milliseconds. */
  at: number
  pid: number
  startedAt: number
  throttle: ThrottleState
  queue: QueueStatus
}
