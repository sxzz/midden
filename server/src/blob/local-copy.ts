import { eq } from 'drizzle-orm'
import { blobThumbnails, removedMedia } from '#db/schema.ts'
import type { Executor } from '#db/client.ts'

/**
 * Why the local original of a blob the bucket holds has to stay, or
 * undefined when it can go: `thumbnail` when its key is also a thumbnail's
 * file, as thumbnails live only locally.
 */
export function localCopyHold(
  db: Executor,
  blob: { hash: string },
): 'thumbnail' | undefined {
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
}
