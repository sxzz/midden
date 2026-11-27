import { sql } from 'drizzle-orm'
import { finalizeSettled } from '#capture/lifecycle.ts'
import { releaseBlobs } from '#capture/maintenance.ts'
import { dropAllSummaries } from '#capture/record-summaries.ts'
import { assets, removedMedia } from '#db/schema.ts'
import { inJson } from '#db/sql.ts'
import { AppError } from '#errors.ts'
import { catalogCollections } from './catalog.ts'
import { list } from './views.ts'
import type { CaptureContext } from '#capture/context.ts'
import type { Executor, Transaction } from '#db/client.ts'

/** At most this many collections per removal, as for an update. */
export const REMOVAL_MAX = 500

/**
 * What to remove (删除媒体): every media item of some collections, or one
 * media item of one collection, named by any of its assets.
 */
export type RemovalTarget =
  { ids: string[] } | { collection: string; asset: string }

/**
 * What a removal does, the same before (dry run) and when applied: how
 * many media items it removes, the bytes their files free once no other
 * collection uses them, and how many stay stored because one still does.
 */
export interface RemovalEffect {
  media: number
  freed_bytes: number
  shared: number
}

/** One asset a removal changes. */
export interface RemovalRow {
  id: string
  capture_id: string
  collection_id: string
  media_key: string
  kind: 'image' | 'video'
  state: string
  blob_id: string | null
}

// The content media of a post, and the banner of a profile; avatars stay,
// as every post by the account shows the same one.
const REMOVABLE = `a.purpose IN ('', 'banner')`

/** The assets a removal changes, across all captures of its collections. */
function plan(db: Executor, target: RemovalTarget): RemovalRow[] {
  const columns = `a.id, a.capture_id, c.collection_id, a.media_key, a.kind,
    a.state, a.blob_id`
  if ('ids' in target)
    return db.all<RemovalRow>(sql`
      SELECT ${sql.raw(columns)} FROM assets a
      JOIN captures c ON c.id = a.capture_id
      WHERE c.collection_id IN (SELECT value FROM json_each(${list(target.ids)}))
        AND ${sql.raw(REMOVABLE)} AND a.state <> 'removed'`)
  const named = db.get<{ media_key: string }>(sql`
    SELECT a.media_key FROM assets a
    JOIN captures c ON c.id = a.capture_id
    WHERE a.id = ${target.asset} AND c.collection_id = ${target.collection}
      AND ${sql.raw(REMOVABLE)}`)
  if (!named) throw new AppError('not_found')
  return db.all<RemovalRow>(sql`
    SELECT ${sql.raw(columns)} FROM assets a
    JOIN captures c ON c.id = a.capture_id
    WHERE c.collection_id = ${target.collection}
      AND a.media_key = ${named.media_key} AND a.state <> 'removed'`)
}

/**
 * What removing these assets does: the media items, the bytes of the blobs
 * only they use, and the items whose blob another asset still uses.
 */
export function removalEffect(
  db: Executor,
  rows: readonly RemovalRow[],
): RemovalEffect {
  const ids = rows.map((row) => row.id)
  const blobIds = [
    ...new Set(rows.flatMap((row) => (row.blob_id ? [row.blob_id] : []))),
  ]
  // A blob any asset outside the removal still uses stays stored.
  const blobs = db.all<{ id: string; size: number; used: number }>(sql`
    SELECT b.id, b.size, EXISTS (SELECT 1 FROM assets o
      WHERE o.blob_id = b.id
        AND o.id NOT IN (SELECT value FROM json_each(${list(ids)}))) AS used
    FROM blobs b WHERE b.id IN (SELECT value FROM json_each(${list(blobIds)}))`)
  const used = new Set(blobs.filter((b) => b.used).map((b) => b.id))
  const keys = new Set(rows.map((row) => row.media_key))
  const shared = new Set(
    rows
      .filter((row) => row.blob_id && used.has(row.blob_id))
      .map((row) => row.media_key),
  )
  return {
    media: keys.size,
    freed_bytes: blobs.reduce((sum, b) => sum + (b.used ? 0 : b.size), 0),
    shared: shared.size,
  }
}

function checkIds(target: RemovalTarget): void {
  if (
    'ids' in target &&
    (!target.ids.length || target.ids.length > REMOVAL_MAX)
  )
    throw new AppError('invalid_request')
}

/** What removing would do, changing nothing. */
export function previewRemoval(
  ctx: Pick<CaptureContext, 'db'>,
  target: RemovalTarget,
): RemovalEffect {
  checkIds(target)
  return ctx.db.transaction((tx) => removalEffect(tx, plan(tx, target)))
}

/**
 * Remove media to save space (删除媒体): drop the collections' references
 * to it in every capture and revision, mark it so no capture of any
 * collection downloads it again, and keep its thumbnail to show it by.
 * The files go with media garbage once nothing else uses them.
 */
export function removeMedia(
  ctx: CaptureContext,
  target: RemovalTarget,
): RemovalEffect {
  checkIds(target)
  return ctx.db.transaction((tx) => {
    const rows = plan(tx, target)
    const result = removalEffect(tx, rows)
    if (rows.length) {
      removeRows(ctx, tx, rows)
      // Media a record counted as failed or missing is gone from it.
      dropAllSummaries(tx)
    }
    // One item already removed everywhere here is marked again, as asked.
    else if ('asset' in target) mark(tx, rows, target)
    return result
  })
}

/**
 * Remove the media of these assets in the open transaction, as
 * `removeMedia` does: mark each item, take the blob off every asset, let
 * captures that waited on them finish, release the blobs nothing else uses
 * and catalog their collections again.
 */
export function removeRows(
  ctx: CaptureContext,
  tx: Transaction,
  rows: readonly RemovalRow[],
): void {
  mark(tx, rows)
  const ids = rows.map((row) => row.id)
  tx.update(assets)
    .set({ state: 'removed', blobId: null, error: '' })
    .where(inJson(assets.id, ids))
    .run()
  // A capture still downloading may have waited on nothing else.
  for (const capture of new Set(
    rows.filter((row) => row.state === 'pending').map((r) => r.capture_id),
  ))
    finalizeSettled(ctx, tx, capture)
  releaseBlobs(tx, [
    ...new Set(rows.flatMap((row) => (row.blob_id ? [row.blob_id] : []))),
  ])
  catalogCollections(tx, [...new Set(rows.map((row) => row.collection_id))])
}

/**
 * Record the marks, each with a thumbnail of the media where one exists and
 * the original's blob; with nothing left to remove, the one item `target`
 * names.
 */
function mark(
  tx: Transaction,
  rows: readonly RemovalRow[],
  target?: RemovalTarget,
): void {
  const media = new Map<string, RemovalRow['kind']>(
    rows.map((row) => [row.media_key, row.kind]),
  )
  if (!media.size && target && 'asset' in target) {
    const named = tx.get<{ media_key: string; kind: RemovalRow['kind'] }>(
      sql`SELECT media_key, kind FROM assets WHERE id = ${target.asset}`,
    )
    if (named) media.set(named.media_key, named.kind)
  }
  for (const [key, kind] of media) {
    const blobIds = rows
      .filter((row) => row.media_key === key && row.blob_id)
      .map((row) => row.blob_id!)
    const thumbnail = tx.get<{
      key: string
      mime: string
      width: number | null
      height: number | null
      size: number | null
      remote_at: number | null
    }>(sql`
      SELECT key, mime, width, height, size, remote_at FROM blob_thumbnails
      WHERE state = 'ready' AND key IS NOT NULL
        AND blob_id IN (SELECT value FROM json_each(${list(blobIds)}))
      LIMIT 1`)
    // The original as it was, to link back if restored in time.
    const blob = tx.get<{
      hash: string
      size: number
      mime: string
      remote_at: number | null
    }>(sql`
      SELECT hash, size, mime, remote_at FROM blobs
      WHERE id IN (SELECT value FROM json_each(${list(blobIds)}))
      LIMIT 1`)
    tx.insert(removedMedia)
      .values({
        mediaKey: key,
        kind,
        blobHash: blob?.hash ?? null,
        blobSize: blob?.size ?? null,
        blobMime: blob?.mime ?? null,
        blobRemoteAt: blob?.remote_at == null ? null : new Date(blob.remote_at),
        thumbnailKey: thumbnail?.key ?? null,
        thumbnailMime: thumbnail?.mime ?? null,
        thumbnailWidth: thumbnail?.width ?? null,
        thumbnailHeight: thumbnail?.height ?? null,
        thumbnailSize: thumbnail?.size ?? null,
        thumbnailRemoteAt:
          thumbnail?.remote_at == null ? null : new Date(thumbnail.remote_at),
      })
      .onConflictDoUpdate({
        target: removedMedia.mediaKey,
        set: {
          thumbnailKey: sql`coalesce(${removedMedia.thumbnailKey}, excluded.thumbnail_key)`,
          thumbnailMime: sql`coalesce(${removedMedia.thumbnailMime}, excluded.thumbnail_mime)`,
          thumbnailWidth: sql`coalesce(${removedMedia.thumbnailWidth}, excluded.thumbnail_width)`,
          thumbnailHeight: sql`coalesce(${removedMedia.thumbnailHeight}, excluded.thumbnail_height)`,
          thumbnailSize: sql`coalesce(${removedMedia.thumbnailSize}, excluded.thumbnail_size)`,
          thumbnailRemoteAt: sql`CASE WHEN ${removedMedia.thumbnailKey} IS NULL THEN excluded.thumbnail_remote_at ELSE ${removedMedia.thumbnailRemoteAt} END`,
          blobHash: sql`coalesce(excluded.blob_hash, ${removedMedia.blobHash})`,
          blobSize: sql`CASE WHEN excluded.blob_hash IS NULL THEN ${removedMedia.blobSize} ELSE excluded.blob_size END`,
          blobMime: sql`CASE WHEN excluded.blob_hash IS NULL THEN ${removedMedia.blobMime} ELSE excluded.blob_mime END`,
          blobRemoteAt: sql`CASE WHEN excluded.blob_hash IS NULL THEN ${removedMedia.blobRemoteAt} ELSE excluded.blob_remote_at END`,
          // Removed again while or after being restored: removed, plainly.
          restore: null,
          restoreAsset: null,
          restoreError: null,
        },
      })
      .run()
  }
}
