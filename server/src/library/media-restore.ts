import { and, eq, isNull, sql } from 'drizzle-orm'
import { dropAllSummaries } from '#capture/record-summaries.ts'
import { linkRestored } from '#capture/restored-media.ts'
import { newId } from '#db/id.ts'
import { blobs, jobs, mediaGarbage, removedMedia } from '#db/schema.ts'
import { AppError } from '#errors.ts'
import { RANK } from '#jobs/queue.ts'
import type { CaptureContext } from '#capture/context.ts'
import type { Transaction } from '#db/client.ts'

/**
 * What a restore did: linked the original back (`ready`), or queued the
 * download job that brings it back (`downloading`).
 */
export type RestoreResult =
  { state: 'ready' } | { state: 'downloading'; job: number }

type Mark = typeof removedMedia.$inferSelect

interface Named {
  media_key: string
  kind: 'image' | 'video'
  state: string
}

function named(
  tx: Transaction,
  collectionId: string,
  assetId: string,
): Named | undefined {
  return tx.get<Named>(sql`
    SELECT a.media_key, a.kind, a.state FROM assets a
    JOIN captures c ON c.id = a.capture_id
    WHERE a.id = ${assetId} AND c.collection_id = ${collectionId}`)
}

function markOf(tx: Transaction, mediaKey: string): Mark | undefined {
  return tx
    .select()
    .from(removedMedia)
    .where(eq(removedMedia.mediaKey, mediaKey))
    .get()
}

/** The blob stored under a hash, if any. */
function blobOf(tx: Transaction, hash: string): string | undefined {
  return tx
    .select({ id: blobs.id })
    .from(blobs)
    .where(eq(blobs.hash, hash))
    .get()?.id
}

/** A garbage key not yet claimed by collection: its file is still there. */
function unclaimed(tx: Transaction, key: string): boolean {
  return !!tx
    .select({ key: mediaGarbage.key })
    .from(mediaGarbage)
    .where(and(eq(mediaGarbage.key, key), isNull(mediaGarbage.claimedAt)))
    .get()
}

/**
 * Link the removed original back in the open transaction, if its blob is
 * still stored (another collection uses it) or its file is garbage not yet
 * collected; `exists` says the file was found just before. Returns whether
 * it was linked.
 */
function relink(
  tx: Transaction,
  mark: Mark,
  collectionId: string,
  exists: boolean,
): boolean {
  const hash = mark.blobHash
  if (!hash) return false
  let blobId = blobOf(tx, hash)
  if (!blobId) {
    // Collection claims a key before deleting its file, in a transaction
    // of its own: unclaimed now, the file found before is still there.
    if (!exists || !mark.blobSize || !mark.blobMime || !unclaimed(tx, hash))
      return false
    blobId = newId()
    tx.insert(blobs)
      .values({
        id: blobId,
        hash,
        size: mark.blobSize,
        mime: mark.blobMime,
        remoteAt: mark.blobRemoteAt,
      })
      .run()
  }
  tx.delete(mediaGarbage)
    .where(and(eq(mediaGarbage.key, hash), isNull(mediaGarbage.claimedAt)))
    .run()
  linkRestored(tx, mark, collectionId, blobId)
  return true
}

/** The download job of an asset, if one is queued or running. */
function downloadJob(tx: Transaction, assetId: string): number | undefined {
  return tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.type, 'download'), eq(jobs.ref, assetId)))
    .get()?.id
}

/**
 * Restore one removed media item (恢复) in a collection, with every asset
 * of it there, as the removal took them. Platform media never changes under
 * its key, so a restore wants exactly the removed bytes back: within the
 * grace period, while its file is still stored, the original is linked
 * back with no request to the platform; after it, the asset's own address
 * (an old banner's, not the account's current one) is downloaded again by
 * the usual download job, ranked as the owner's. Meanwhile the kept
 * thumbnail stands in, and the media is no longer skipped by captures.
 */
export async function restoreMedia(
  ctx: CaptureContext,
  collectionId: string,
  assetId: string,
): Promise<RestoreResult> {
  const read = ctx.db.transaction((tx) => {
    const asset = named(tx, collectionId, assetId)
    if (!asset) throw new AppError('not_found')
    return { asset, mark: markOf(tx, asset.media_key) }
  })
  const { asset, mark } = read
  if (asset.state === 'ready') return { state: 'ready' }
  // Failed media is no removal: 重试 downloads it again.
  if (asset.state === 'failed') throw new AppError('invalid_request')
  const hash = mark?.blobHash
  if (hash && mark.restore !== 'downloading') {
    // The same lock as collection takes (in one process); the claim
    // (`claimed_at`) is what keeps the worker's collection out otherwise.
    const linked = await ctx.mediaLocks.run(hash, async () => {
      const exists = (await ctx.blobs.stat(hash)) !== undefined
      return ctx.db.transaction((tx) => {
        const current = markOf(tx, asset.media_key)
        if (current?.blobHash !== hash || current.restore === 'downloading')
          return false
        if (!relink(tx, current, collectionId, exists)) return false
        dropAllSummaries(tx)
        return true
      })
    })
    if (linked) return { state: 'ready' }
  }
  return ctx.db.transaction((tx): RestoreResult => {
    const current = named(tx, collectionId, assetId)
    if (!current) throw new AppError('not_found')
    if (current.state === 'ready') return { state: 'ready' }
    // Already downloading, for this asset or another of the same media.
    const restoring = markOf(tx, current.media_key)
    for (const id of new Set([
      assetId,
      ...(restoring?.restore === 'downloading' && restoring.restoreAsset
        ? [restoring.restoreAsset]
        : []),
    ])) {
      const queued = downloadJob(tx, id)
      if (queued) return { state: 'downloading', job: queued }
    }
    const restore = {
      restore: 'downloading' as const,
      restoreAsset: assetId,
      restoreError: null,
    }
    // A mark cleared by an earlier restore that left the media to the next
    // capture (恢复下载 before) gets one again, to follow this download by.
    tx.insert(removedMedia)
      .values({ mediaKey: current.media_key, kind: current.kind, ...restore })
      .onConflictDoUpdate({ target: removedMedia.mediaKey, set: restore })
      .run()
    tx.run(sql`UPDATE assets SET state = 'pending', error = ''
      WHERE id = ${assetId} AND state IN ('removed', 'pending')`)
    dropAllSummaries(tx)
    const job = ctx.queue.enqueue(tx, 'download', assetId, {
      rank: RANK.manual,
      updateId: null,
    })
    return { state: 'downloading', job }
  })
}
