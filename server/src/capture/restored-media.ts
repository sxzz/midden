import { and, eq, isNull, or, sql } from 'drizzle-orm'
import {
  assets,
  blobThumbnails,
  mediaGarbage,
  removedMedia,
} from '#db/schema.ts'
import { catalogCollections } from '#library/catalog.ts'
import type { Transaction } from '#db/client.ts'

// The end of a restore (恢复) that downloads the original again (see
// `library/media-restore.ts`): the download job (`download.ts`) settles the
// removal mark it left standing, `restore` set, as the placeholder.

type Mark = typeof removedMedia.$inferSelect

function restoring(tx: Transaction, mediaKey: string): Mark | undefined {
  return tx
    .select()
    .from(removedMedia)
    .where(
      and(
        eq(removedMedia.mediaKey, mediaKey),
        eq(removedMedia.restore, 'downloading'),
      ),
    )
    .get()
}

/** The collection an asset belongs to. */
export function collectionOf(
  tx: Transaction,
  assetId: string,
): string | undefined {
  return tx.get<{ id: string }>(sql`
    SELECT c.collection_id AS id FROM assets a
    JOIN captures c ON c.id = a.capture_id
    WHERE a.id = ${assetId}`)?.id
}

/**
 * Give the media's thumbnail kept on its mark to its blob, when the blob
 * has none: the same platform rendition of the same media, so nothing is
 * fetched again. Otherwise the kept one is garbage, unless still in use.
 */
export function keepThumbnail(tx: Transaction, mark: Mark, blobId: string) {
  if (!mark.thumbnailKey) return
  const attached =
    !!mark.thumbnailMime &&
    tx
      .insert(blobThumbnails)
      .values({
        blobId,
        state: 'ready',
        key: mark.thumbnailKey,
        size: mark.thumbnailSize,
        mime: mark.thumbnailMime,
        width: mark.thumbnailWidth,
        height: mark.thumbnailHeight,
        remoteAt: mark.thumbnailRemoteAt,
      })
      .onConflictDoNothing()
      .run().changes > 0
  if (attached)
    // Claimed back from collection, which never claims a mark's thumbnail.
    tx.delete(mediaGarbage)
      .where(
        and(
          eq(mediaGarbage.key, mark.thumbnailKey),
          isNull(mediaGarbage.claimedAt),
        ),
      )
      .run()
  else
    tx.insert(mediaGarbage)
      .values({ key: mark.thumbnailKey })
      .onConflictDoNothing()
      .run()
}

/**
 * Link a restored item back in the collection it was restored in: every
 * asset of that media there still removed, and the one whose download
 * restores it, take the blob, as a removal took it from all of them. The
 * mark goes; its thumbnail goes to the blob or to garbage.
 */
export function linkRestored(
  tx: Transaction,
  mark: Mark,
  collectionId: string,
  blobId: string,
): void {
  tx.update(assets)
    .set({ state: 'ready', blobId, error: '' })
    .where(
      and(
        eq(assets.mediaKey, mark.mediaKey),
        or(
          eq(assets.state, 'removed'),
          and(
            eq(assets.state, 'pending'),
            eq(assets.id, mark.restoreAsset ?? ''),
          ),
        ),
        sql`${assets.captureId} IN (SELECT id FROM captures
          WHERE collection_id = ${collectionId})`,
      ),
    )
    .run()
  tx.delete(removedMedia).where(eq(removedMedia.mediaKey, mark.mediaKey)).run()
  keepThumbnail(tx, mark, blobId)
  catalogCollections(tx, [collectionId])
}

/**
 * An asset was attached to a blob: if its media is being restored, the
 * restore is done, whichever capture's download brought the file.
 */
export function settleRestored(
  tx: Transaction,
  asset: { id: string; mediaKey: string },
  blobId: string,
): void {
  const mark = restoring(tx, asset.mediaKey)
  if (!mark) return
  const collection =
    (mark.restoreAsset && collectionOf(tx, mark.restoreAsset)) ??
    collectionOf(tx, asset.id)
  if (collection) linkRestored(tx, mark, collection, blobId)
}

/**
 * The download restoring a media item failed for good: the asset is removed
 * again, shown by the kept thumbnail, and the mark records why (无法重新下载)
 * and skips the media again until the next restore. Returns whether the
 * asset was one a restore downloads.
 */
export function failRestored(
  tx: Transaction,
  asset: { id: string; mediaKey: string },
  message: string,
): boolean {
  const mark = restoring(tx, asset.mediaKey)
  if (mark?.restoreAsset !== asset.id) return false
  tx.update(assets)
    .set({ state: 'removed', blobId: null, error: '' })
    .where(and(eq(assets.id, asset.id), eq(assets.state, 'pending')))
    .run()
  tx.update(removedMedia)
    .set({ restore: 'failed', restoreError: message })
    .where(eq(removedMedia.mediaKey, mark.mediaKey))
    .run()
  return true
}
