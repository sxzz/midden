import { and, eq, ne } from 'drizzle-orm'
import { assets, blobThumbnails } from '#db/schema.ts'
import { thumbnailsEnabled } from './thumbnail.ts'
import type { Transaction } from '#db/client.ts'
import type { CaptureContext } from './context.ts'

// What a capture's fetch (`fetch.ts`) and a download (`download.ts`) share
// when an asset takes a blob already stored. Kept apart from the download,
// which the web build's types do not cover.

/** The blob another asset of the same rendition (immutable key) has. */
export function cachedBlob(
  tx: Transaction,
  cacheKey: string,
): string | undefined {
  if (!cacheKey) return
  return (
    tx
      .select({ blobId: assets.blobId })
      .from(assets)
      .where(
        and(
          eq(assets.cacheKey, cacheKey),
          eq(assets.state, 'ready'),
          // Spelled out so SQLite can use the partial index `assets_cache`.
          ne(assets.cacheKey, ''),
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
