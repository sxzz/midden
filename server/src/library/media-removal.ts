import { sql } from 'drizzle-orm'
import { finalizeSettled } from '#capture/lifecycle.ts'
import { releaseBlobs } from '#capture/maintenance.ts'
import { assets, mediaGarbage, removedMedia } from '#db/schema.ts'
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

interface Row {
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
function plan(db: Executor, target: RemovalTarget): Row[] {
  const columns = `a.id, a.capture_id, c.collection_id, a.media_key, a.kind,
    a.state, a.blob_id`
  if ('ids' in target)
    return db.all<Row>(sql`
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
  return db.all<Row>(sql`
    SELECT ${sql.raw(columns)} FROM assets a
    JOIN captures c ON c.id = a.capture_id
    WHERE c.collection_id = ${target.collection}
      AND a.media_key = ${named.media_key} AND a.state <> 'removed'`)
}

function effect(db: Executor, rows: Row[]): RemovalEffect {
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
  return ctx.db.transaction((tx) => effect(tx, plan(tx, target)))
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
    const result = effect(tx, rows)
    if (!rows.length && 'ids' in target) return result
    mark(tx, rows, target)
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
    return result
  })
}

/** Record the marks, each with a thumbnail of the media where one exists. */
function mark(tx: Transaction, rows: Row[], target: RemovalTarget): void {
  const media = new Map<string, Row['kind']>(
    rows.map((row) => [row.media_key, row.kind]),
  )
  // One item already removed everywhere here is marked again, as asked.
  if (!media.size && 'asset' in target) {
    const named = tx.get<{ media_key: string; kind: Row['kind'] }>(
      sql`SELECT media_key, kind FROM assets WHERE id = ${target.asset}`,
    )
    if (named) media.set(named.media_key, named.kind)
  }
  for (const [key, kind] of media) {
    const blobIds = rows
      .filter((row) => row.media_key === key && row.blob_id)
      .map((row) => row.blob_id!)
    const thumbnail = tx.get<{ key: string; mime: string }>(sql`
      SELECT key, mime FROM blob_thumbnails
      WHERE state = 'ready' AND key IS NOT NULL
        AND blob_id IN (SELECT value FROM json_each(${list(blobIds)}))
      LIMIT 1`)
    tx.insert(removedMedia)
      .values({
        mediaKey: key,
        kind,
        thumbnailKey: thumbnail?.key ?? null,
        thumbnailMime: thumbnail?.mime ?? null,
      })
      .onConflictDoUpdate({
        target: removedMedia.mediaKey,
        set: {
          thumbnailKey: sql`coalesce(${removedMedia.thumbnailKey}, excluded.thumbnail_key)`,
          thumbnailMime: sql`coalesce(${removedMedia.thumbnailMime}, excluded.thumbnail_mime)`,
        },
      })
      .run()
  }
}

/**
 * Clear the mark of one removed media item (恢复下载): the next capture
 * listing it downloads it again. Its kept thumbnail becomes garbage unless
 * something else still uses it.
 */
export function restoreMedia(
  ctx: Pick<CaptureContext, 'db'>,
  collectionId: string,
  assetId: string,
): void {
  ctx.db.transaction((tx) => {
    const named = tx.get<{ media_key: string }>(sql`
      SELECT a.media_key FROM assets a
      JOIN captures c ON c.id = a.capture_id
      WHERE a.id = ${assetId} AND c.collection_id = ${collectionId}`)
    if (!named) throw new AppError('not_found')
    const cleared = tx
      .delete(removedMedia)
      .where(sql`${removedMedia.mediaKey} = ${named.media_key}`)
      .returning({ thumbnail: removedMedia.thumbnailKey })
      .get()
    if (cleared?.thumbnail)
      tx.insert(mediaGarbage)
        .values({ key: cleared.thumbnail })
        .onConflictDoNothing()
        .run()
  })
}
