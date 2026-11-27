import type { KeyedLock } from '#blob/locks.ts'
import type { BlobStore } from '#blob/store.ts'
import type { Database } from '#db/client.ts'
import type { JobQueue } from '#jobs/queue.ts'
import type { Logger } from '#log.ts'
import type { Platforms } from '#platforms/registry.ts'
import type { RawStore } from '#raw/store.ts'

/** Everything the capture pipeline works with. */
export interface CaptureContext {
  db: Database
  queue: JobQueue
  platforms: Platforms
  blobs: BlobStore
  logger: Logger
  /** Where downloads are staged before they enter the media store. */
  stagingDir: string
  /** Decrypt a stored credential. */
  openCredential: (ref: string) => Uint8Array
  now?: () => number
  /** Serializes writes and deletions of one media key. */
  mediaLocks: KeyedLock
  /**
   * The private bucket raw responses move to once their capture finished;
   * without it they stay in the database.
   */
  raw?: RawStore
  /** HTTP client for media downloads. */
  fetch?: typeof fetch
  /** Overrides `TIMELINE_CAP`, so tests need not read a thousand posts. */
  timelineCap?: number
  /**
   * Waits between the write transactions of one long task, longer while
   * the worker's throttle sees contention, so that another process waiting
   * for the write lock (the web process) gets it in between.
   */
  pace?: () => Promise<void>
}

/** `ctx.pace`, or a turn of the event loop without one. */
export function pace(ctx: Pick<CaptureContext, 'pace'>): Promise<void> {
  return ctx.pace ? ctx.pace() : new Promise((resolve) => setImmediate(resolve))
}

export const MAX_MEDIA = 20
export const MAX_PURPOSED_MEDIA = 16
// A running capture enqueues its related task itself when it ends; the one
// queued at submit time is only the fallback.
export const RELATED_FALLBACK_MS = 10_000
