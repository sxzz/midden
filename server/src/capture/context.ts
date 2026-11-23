import type { BlobStore } from '#blob/store.ts'
import type { Database } from '#db/client.ts'
import type { JobQueue } from '#jobs/queue.ts'
import type { Logger } from '#log.ts'
import type { Platforms } from '#platforms/registry.ts'

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
}

export const MAX_MEDIA = 20
export const MAX_PURPOSED_MEDIA = 16
// A running capture enqueues its related task itself when it ends; the one
// queued at submit time is only the fallback.
export const RELATED_FALLBACK_MS = 10_000
