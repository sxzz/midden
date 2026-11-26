import { and, eq, isNull, ne } from 'drizzle-orm'
import { assets, blobThumbnails } from '#db/schema.ts'
import { thumbnailsEnabled } from './thumbnail.ts'
import type { Transaction } from '#db/client.ts'
import type { CaptureContext } from './context.ts'

// What a capture's fetch (`fetch.ts`) and a download (`download.ts`) share
// when an asset takes a blob already stored. Kept apart from the download,
// which the web build's types do not cover.

/**
 * What names an asset's rendition for reuse: its own `cache_key`, or its
 * `media_key` where that is NULL (the same key, not stored twice). Empty when
 * it has no immutable key, which is never reused.
 */
export function reuseKey(asset: {
  cacheKey: string | null
  mediaKey: string
}): string {
  return asset.cacheKey ?? asset.mediaKey
}

/** The blob another asset of the same rendition (`reuseKey`) has. */
export function cachedBlob(tx: Transaction, key: string): string | undefined {
  if (!key) return
  const own = tx
    .select({ blobId: assets.blobId })
    .from(assets)
    .where(
      and(
        eq(assets.cacheKey, key),
        eq(assets.state, 'ready'),
        // Spelled out so SQLite can use the partial index `assets_cache`.
        ne(assets.cacheKey, ''),
      ),
    )
    .get()
  if (own?.blobId) return own.blobId
  // Assets whose rendition is their media key have no `cache_key`.
  return (
    tx
      .select({ blobId: assets.blobId })
      .from(assets)
      .where(
        and(
          eq(assets.mediaKey, key),
          isNull(assets.cacheKey),
          eq(assets.state, 'ready'),
        ),
      )
      .get()?.blobId ?? undefined
  )
}

/** A ready asset makes its blob's thumbnail due. */
export function enqueueThumbnail(
  ctx: CaptureContext,
  tx: Transaction,
  blobId: string,
): void {
  if (!thumbnailsEnabled(ctx)) return
  const done = tx
    .select({ id: blobThumbnails.blobId })
    .from(blobThumbnails)
    .where(eq(blobThumbnails.blobId, blobId))
    .get()
  if (!done) ctx.queue.enqueue(tx, 'thumbnail', blobId)
}
