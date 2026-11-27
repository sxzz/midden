import { and, eq, isNull } from 'drizzle-orm'
import { blobThumbnails, removedMedia } from '#db/schema.ts'
import type { Executor } from '#db/client.ts'

/**
 * Why the local original of a blob the bucket holds has to stay, or
 * undefined when it can go: `thumbnail` when its key is also the file of a
 * thumbnail not yet moved to the bucket (`capture/thumbnail-remote.ts`),
 * which is served from the local file until then.
 */
export function localCopyHold(
  db: Executor,
  blob: { hash: string },
): 'thumbnail' | undefined {
  const thumbnail =
    db
      .select({ id: blobThumbnails.blobId })
      .from(blobThumbnails)
      .where(
        and(eq(blobThumbnails.key, blob.hash), isNull(blobThumbnails.remoteAt)),
      )
      .get() ??
    db
      .select({ id: removedMedia.mediaKey })
      .from(removedMedia)
      .where(
        and(
          eq(removedMedia.thumbnailKey, blob.hash),
          isNull(removedMedia.thumbnailRemoteAt),
        ),
      )
      .get()
  if (thumbnail) return 'thumbnail'
}
