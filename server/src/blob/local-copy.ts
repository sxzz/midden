import { and, eq } from 'drizzle-orm'
import { blobThumbnails, jobs, removedMedia } from '#db/schema.ts'
import type { Executor } from '#db/client.ts'

/**
 * Why the local original of a blob the bucket holds has to stay for now,
 * or undefined when it can go:
 * - `thumbnail`: its key is also a thumbnail's file, and thumbnails live
 *   only locally;
 * - `thumbnail-due`: its thumbnail job has not finished, and renders from
 *   the local file. That job asks for the deletion again once done.
 */
export function localCopyHold(
  db: Executor,
  blob: { id: string; hash: string },
): 'thumbnail' | 'thumbnail-due' | undefined {
  const thumbnail =
    db
      .select({ id: blobThumbnails.blobId })
      .from(blobThumbnails)
      .where(eq(blobThumbnails.key, blob.hash))
      .get() ??
    db
      .select({ id: removedMedia.mediaKey })
      .from(removedMedia)
      .where(eq(removedMedia.thumbnailKey, blob.hash))
      .get()
  if (thumbnail) return 'thumbnail'
  const settled = db
    .select({ id: blobThumbnails.blobId })
    .from(blobThumbnails)
    .where(eq(blobThumbnails.blobId, blob.id))
    .get()
  if (settled) return
  const due = db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.type, 'thumbnail'), eq(jobs.ref, blob.id)))
    .get()
  if (due) return 'thumbnail-due'
}
