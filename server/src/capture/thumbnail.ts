import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { KeyedLock } from '#blob/locks.ts'
import {
  assets,
  blobs,
  blobThumbnails,
  mediaGarbage,
  removedMedia,
} from '#db/schema.ts'
import { PermanentError } from '#jobs/queue.ts'
import { imageSize } from './image-size.ts'
import { fetchMedia, mediaURL } from './media-fetch.ts'
import { thumbnailDue } from './media-reuse.ts'
import { acceptsMediaType, sniffMediaType } from './media-type.ts'
import type { Incoming } from '#blob/store.ts'
import type { Executor } from '#db/client.ts'
import type { CaptureContext } from './context.ts'

// Thumbnails are the platforms' own smaller renditions (see
// `platforms/x/thumbnails.ts`, `platforms/instagram/thumbnails.ts`), named
// by the asset's `thumbnail_url` when it is listed and downloaded right
// after the original, by the same job (`download.ts`). They are stored by
// content hash like any media, streamed straight into the bucket with R2;
// those made before that are moved there (`thumbnail-remote.ts`). An image the
// platform has no smaller size of has no thumbnail: the web shows the
// original, which is no larger. A video without a poster has none either.

const REQUEST_TIMEOUT = 60_000
const blobLocks = new KeyedLock()

type Blob = typeof blobs.$inferSelect

/** Record a thumbnail that failed for good, so it is not fetched again. */
export function failThumbnail(
  db: Executor,
  blobId: string | null,
  message: string,
): void {
  if (!blobId || !db.select().from(blobs).where(eq(blobs.id, blobId)).get())
    return
  db.insert(blobThumbnails)
    .values({ blobId, state: 'failed', error: message })
    .onConflictDoNothing()
    .run()
}

interface Fetched {
  incoming: Incoming
  mime: string
  width: number
  height: number
}

/**
 * Fetch a thumbnail into the media store, not yet kept, with its size read
 * from its first bytes. Rejects with a `PermanentError` for what will not change by
 * asking again: a refused request, something not an image.
 */
async function fetchThumbnail(
  ctx: CaptureContext,
  address: string,
  signal: AbortSignal,
): Promise<Fetched> {
  const incoming = await fetchMedia(
    ctx,
    mediaURL(address),
    AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT)]),
  )
  try {
    if (incoming.size === 0) throw new PermanentError('媒体文件为空')
    const mime = sniffMediaType(incoming.head)
    if (!acceptsMediaType('image', mime))
      throw new PermanentError('不支持的媒体格式')
    const size = imageSize(incoming.head) ?? { width: 0, height: 0 }
    return { incoming, mime, ...size }
  } catch (error) {
    await incoming.discard()
    throw error
  }
}

/**
 * Keep a fetched thumbnail under its hash, claiming the key back from
 * garbage first; `then` records it, told whether the bucket holds it.
 */
async function storeFile(
  ctx: CaptureContext,
  fetched: Fetched,
  then: (remoteAt: Date | null) => void,
): Promise<void> {
  const { incoming, mime } = fetched
  await ctx.mediaLocks.run(incoming.hash, async () => {
    ctx.db.delete(mediaGarbage).where(eq(mediaGarbage.key, incoming.hash)).run()
    const { remote } = await incoming.keep(mime)
    then(remote ? new Date(ctx.now?.() ?? Date.now()) : null)
  })
}

/**
 * Download the thumbnail of a ready asset's blob, when one is due. A
 * thumbnail that cannot be had is recorded as failed at once; an error
 * worth another try (a busy server, a dropped connection) is thrown for
 * the job to retry.
 */
export async function downloadThumbnail(
  ctx: CaptureContext,
  assetId: string,
  signal: AbortSignal,
): Promise<void> {
  const asset = ctx.db.select().from(assets).where(eq(assets.id, assetId)).get()
  if (asset?.state !== 'ready' || !asset.blobId) return
  const blobId = asset.blobId
  await blobLocks.run(blobId, async () => {
    if (!thumbnailDue(ctx.db, asset)) return
    const blob = ctx.db.select().from(blobs).where(eq(blobs.id, blobId)).get()
    if (!blob) return
    let fetched: Fetched
    try {
      fetched = await fetchThumbnail(ctx, asset.thumbnailUrl!, signal)
    } catch (error) {
      if (!(error instanceof PermanentError)) throw error
      ctx.logger.warn(
        { assetId, blobId, err: error },
        'thumbnail download failed',
      )
      failThumbnail(ctx.db, blobId, error.message)
      return
    }
    try {
      // The platform sent the original itself: it stands for itself.
      if (fetched.incoming.hash === blob.hash) return
      await storeFile(ctx, fetched, (remoteAt) =>
        attachThumbnail(ctx, blob, fetched, remoteAt),
      )
    } finally {
      await fetched.incoming.discard()
    }
  })
}

function attachThumbnail(
  ctx: CaptureContext,
  blob: Blob,
  { incoming, mime, width, height }: Fetched,
  remoteAt: Date | null,
): void {
  ctx.db.transaction((tx) => {
    const attached =
      !!tx.select().from(blobs).where(eq(blobs.id, blob.id)).get() &&
      tx
        .insert(blobThumbnails)
        .values({
          blobId: blob.id,
          state: 'ready',
          key: incoming.hash,
          size: incoming.size,
          mime,
          width,
          height,
          remoteAt,
        })
        .onConflictDoNothing()
        .run().changes > 0
    // The blob went away meanwhile; the file is garbage unless shared.
    if (!attached)
      tx.insert(mediaGarbage)
        .values({ key: incoming.hash })
        .onConflictDoNothing()
        .run()
  })
}

export interface RegeneratedThumbnail {
  key: string
  contentType: string
}

const regenerating = new Map<
  string,
  Promise<RegeneratedThumbnail | undefined>
>()

/**
 * When a thumbnail's file is missing (the media directory was lost before
 * it moved to the remote store, say), fetch it again from the platform, where its
 * address still works. The bytes may differ from the lost ones; then the
 * thumbnail is recorded under its new key, which the caller sends the
 * browser to. Where it cannot be fetched, an image's thumbnail is its
 * original. Undefined when the key is no blob's thumbnail (a removed media
 * item's, whose original is gone) or nothing stands in for it.
 */
export function regenerateThumbnail(
  ctx: CaptureContext,
  key: string,
): Promise<RegeneratedThumbnail | undefined> {
  let pending = regenerating.get(key)
  if (!pending) {
    pending = refetch(ctx, key).finally(() => regenerating.delete(key))
    regenerating.set(key, pending)
  }
  return pending
}

async function refetch(
  ctx: CaptureContext,
  key: string,
): Promise<RegeneratedThumbnail | undefined> {
  const row = ctx.db
    .select({ blob: blobs })
    .from(blobThumbnails)
    .innerJoin(blobs, eq(blobs.id, blobThumbnails.blobId))
    .where(and(eq(blobThumbnails.key, key), eq(blobThumbnails.state, 'ready')))
    .get()
  if (!row) return
  const { blob } = row
  const original = blob.mime.startsWith('image/')
    ? { key: blob.hash, contentType: blob.mime }
    : undefined
  const address = ctx.db
    .select({ url: assets.thumbnailUrl })
    .from(assets)
    .where(and(eq(assets.blobId, blob.id), isNotNull(assets.thumbnailUrl)))
    // The latest listing's address is the likeliest to work still.
    .orderBy(sql`${assets}.rowid DESC`)
    .get()?.url
  if (!address) return original
  let fetched: Fetched
  try {
    fetched = await fetchThumbnail(
      ctx,
      address,
      AbortSignal.timeout(REQUEST_TIMEOUT),
    )
  } catch (error) {
    ctx.logger.warn({ err: error, key }, 'thumbnail regeneration failed')
    return original
  }
  try {
    const { incoming, mime, width, height } = fetched
    if (incoming.hash === blob.hash) return original
    await storeFile(ctx, fetched, (remoteAt) => {
      ctx.db.transaction((tx) => {
        if (incoming.hash === key) {
          // The same bytes again, back where they were lost.
          tx.update(blobThumbnails)
            .set({ remoteAt })
            .where(eq(blobThumbnails.key, key))
            .run()
          tx.update(removedMedia)
            .set({ thumbnailRemoteAt: remoteAt })
            .where(eq(removedMedia.thumbnailKey, key))
            .run()
          return
        }
        // Whatever showed the lost file shows the new one.
        tx.update(blobThumbnails)
          .set({
            key: incoming.hash,
            size: incoming.size,
            mime,
            width,
            height,
            remoteAt,
          })
          .where(eq(blobThumbnails.key, key))
          .run()
        tx.update(removedMedia)
          .set({
            thumbnailKey: incoming.hash,
            thumbnailMime: mime,
            thumbnailWidth: width,
            thumbnailHeight: height,
            thumbnailSize: incoming.size,
            thumbnailRemoteAt: remoteAt,
          })
          .where(eq(removedMedia.thumbnailKey, key))
          .run()
        // A stray copy of the old key (in the bucket, say) is collected.
        tx.insert(mediaGarbage).values({ key }).onConflictDoNothing().run()
      })
    })
    ctx.logger.info(
      { key, regenerated: incoming.hash },
      'thumbnail regenerated',
    )
    return { key: incoming.hash, contentType: mime }
  } finally {
    await fetched.incoming.discard()
  }
}
