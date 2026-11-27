import { Buffer } from 'node:buffer'
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from 'drizzle-orm'
import {
  assets,
  blobs,
  blobThumbnails,
  captureRunning,
  captures,
  captureSaved,
  collections,
  entities,
  entityVersions,
  followEdges,
  jobs,
  library,
  mediaGarbage,
  removedMedia,
  revisionEntities,
  revisions,
  sourceResponses,
  submissions,
} from '#db/schema.ts'
import { inJson } from '#db/sql.ts'
import { catalogCollections } from '#library/catalog.ts'
import { backfillBatch } from '#library/facets.ts'
import { deleteSourceResponses } from '#raw/responses.ts'
import { collectRawGarbage, sweepRawUploads } from '#raw/upload.ts'
import { pace, type CaptureContext } from './context.ts'
import { settleHandleProfiles } from './identify.ts'
import { HEADER_BYTES, imageSize } from './image-size.ts'
import { failCapture } from './lifecycle.ts'
import { dropAllSummaries } from './record-summaries.ts'
import { pruneStaging } from './staging.ts'
import { moveThumbnails } from './thumbnail-remote.ts'
import type { Transaction } from '#db/client.ts'

const STALE_CAPTURE = 60 * 60_000
const RAW_KEEP = 3 * 24 * 60 * 60_000
const MEDIA_GRACE = 24 * 60 * 60_000
const BATCH = 100
const PRUNE_BATCH = 500

// Free pages go back to the file system 16 MiB at a time, at most every 15
// minutes, once there are 4 MiB of them: a quarter-hour's deletions are far
// less, and a backlog (after moving raw responses out) drains at 64 MiB an
// hour without long writes.
const VACUUM_EVERY = 15 * 60_000
const VACUUM_PAGES = 4096
const VACUUM_MIN_FREE = 1024
/** SQLite's `auto_vacuum` value for INCREMENTAL. */
const INCREMENTAL = 2

// Sizes are read from the first 64 KiB of each thumbnail, several at a time
// (from the remote store, a request each). A pass runs batches for up to
// SIZE_BUDGET, so a backlog of 100,000 clears in an hour or two, not a day.
const SIZE_BATCH = 400
const SIZE_READS = 8
const SIZE_BUDGET = 20_000

// Facets (`library/facets.ts`) of rows catalogued before them: 500 rows a
// write transaction, for up to FACETS_BUDGET a pass while the worker stays
// idle. On a copy of the development database (60,000 rows) a batch takes
// 11 ms at the median, 35 ms at most, and the whole backfill 1.5 s.
const FACETS_BATCH = 500
const FACETS_BUDGET = 20_000

const sizesCaughtUp = new WeakSet<CaptureContext>()
const facetsCaughtUp = new WeakSet<CaptureContext>()
const vacuumedAt = new WeakMap<CaptureContext, number>()
const BUDGET = 30_000

/**
 * One maintenance pass. Steps are independent; errors are collected.
 * Without `slim` (the worker is busy), the steps that only give back space
 * wait for another pass: removing deleted collections and old raw
 * responses, raw garbage, free pages.
 */
export async function runMaintenance(
  ctx: CaptureContext,
  options: { slim?: boolean } = {},
): Promise<void> {
  const slim = options.slim ?? true
  const errors: unknown[] = []
  const step = async (name: string, fn: () => unknown) => {
    try {
      await fn()
    } catch (error) {
      ctx.logger.error({ err: error, step: name }, 'maintenance step failed')
      errors.push(error)
    }
  }
  await step('stale captures', () => failStaleCaptures(ctx))
  if (slim) await step('collections', () => collectCollections(ctx))
  if (slim) await step('raw responses', () => pruneSourceResponses(ctx))
  await step('staged data', () => pruneStaging(ctx))
  await step('media', () => collectMedia(ctx))
  if (slim) await step('raw garbage', () => collectRawGarbage(ctx))
  await step('raw uploads', () => sweepRawUploads(ctx))
  if (slim) await step('thumbnail sizes', () => backfillThumbnailSizes(ctx))
  if (slim)
    await step('facets', () =>
      backfillFacets(ctx, () => ctx.queue.status().idle),
    )
  if (slim)
    await step('thumbnails to the remote store', () =>
      moveThumbnails(ctx, () => ctx.queue.status().idle),
    )
  if (slim)
    await step('profiles saved by handle', async () => {
      const settled = await settleHandleProfiles(ctx, { network: true })
      if (settled.local || settled.identified || settled.failed)
        ctx.logger.info(settled, 'profiles saved by handle settled')
    })
  if (slim) await step('free pages', () => releaseFreePages(ctx))
  if (errors.length) throw new AggregateError(errors, 'maintenance failed')
}

const now = (ctx: CaptureContext) => ctx.now?.() ?? Date.now()

/** Captures left unfinished with no job to finish them. */
export function failStaleCaptures(ctx: CaptureContext): number {
  const cutoff = new Date(now(ctx) - STALE_CAPTURE)
  const stale = ctx.db
    .select({ id: captures.id })
    .from(captures)
    .where(
      and(
        captureRunning,
        lt(captures.createdAt, cutoff),
        sql`NOT EXISTS (SELECT 1 FROM ${jobs} WHERE ${jobs.ref} = ${captures.id} OR ${jobs.ref} IN (SELECT ${assets.id} FROM ${assets} WHERE ${assets.captureId} = ${captures.id}))`,
      ),
    )
    .limit(BATCH)
    .all()
  for (const { id } of stale)
    ctx.db.transaction((tx) => failCapture(ctx, tx, id, '采集被中断'))
  return stale.length
}

/**
 * Remove collections nothing saves any more, once no capture of them is
 * running, with everything only they used.
 */
export async function collectCollections(ctx: CaptureContext): Promise<number> {
  const started = Date.now()
  let removed = 0
  for (;;) {
    const count = ctx.db.transaction((tx) =>
      collectBatch(tx, new Date(now(ctx))),
    )
    removed += count
    if (count < BATCH || Date.now() - started > BUDGET) return removed
    // Batch after batch would keep the write lock from the web process.
    await pace(ctx)
  }
}

function collectBatch(tx: Transaction, at: Date): number {
  const candidates = tx
    .select({ id: collections.id })
    .from(collections)
    .where(
      and(
        isNotNull(collections.unreferencedAt),
        sql`NOT EXISTS (SELECT 1 FROM ${library} WHERE ${library.collectionId} = ${collections.id})`,
        sql`NOT EXISTS (SELECT 1 FROM ${captures} WHERE ${captures.collectionId} = ${collections.id} AND ${captures.state} IN ('queued', 'downloading'))`,
      ),
    )
    .orderBy(asc(collections.unreferencedAt))
    .limit(BATCH)
    .all()
    .map((row) => row.id)
  if (!candidates.length) return 0
  // Records counted over what is removed here are counted again.
  dropAllSummaries(tx)
  const captureIds = tx
    .select({ id: captures.id })
    .from(captures)
    .where(inArray(captures.collectionId, candidates))
    .all()
    .map((row) => row.id)
  const blobIds = captureIds.length
    ? tx
        .selectDistinct({ id: assets.blobId })
        .from(assets)
        .where(
          and(inArray(assets.captureId, captureIds), isNotNull(assets.blobId)),
        )
        .all()
        .map((row) => row.id!)
    : []
  // What the removed revisions used; only these can become orphans.
  const versionIds = tx
    .selectDistinct({ id: revisionEntities.entityVersionId })
    .from(revisionEntities)
    .innerJoin(revisions, eq(revisions.id, revisionEntities.revisionId))
    .where(inArray(revisions.collectionId, candidates))
    .all()
    .map((row) => row.id)
  tx.update(collections)
    .set({ currentRevision: null })
    .where(inArray(collections.id, candidates))
    .run()
  if (captureIds.length) {
    tx.update(captures)
      .set({ revisionId: null })
      .where(inArray(captures.id, captureIds))
      .run()
    tx.delete(submissions)
      .where(inArray(submissions.captureId, captureIds))
      .run()
    tx.delete(assets).where(inArray(assets.captureId, captureIds)).run()
    deleteSourceResponses(tx, captureIds, at)
  }
  tx.delete(revisions).where(inArray(revisions.collectionId, candidates)).run()
  if (captureIds.length)
    tx.delete(captures).where(inArray(captures.id, captureIds)).run()
  tx.delete(collections).where(inArray(collections.id, candidates)).run()

  if (versionIds.length) {
    const orphans = tx
      .delete(entityVersions)
      .where(
        and(
          inJson(entityVersions.id, versionIds),
          sql`NOT EXISTS (SELECT 1 FROM ${revisionEntities} WHERE ${revisionEntities.entityVersionId} = ${entityVersions.id})`,
        ),
      )
      .returning({ entityId: entityVersions.entityId })
      .all()
    const entityIds = [...new Set(orphans.map((row) => row.entityId))]
    if (entityIds.length)
      tx.delete(entities)
        .where(
          and(
            inJson(entities.id, entityIds),
            sql`NOT EXISTS (SELECT 1 FROM ${entityVersions} WHERE ${entityVersions.entityId} = ${entities.id})`,
            // An account's follows outlive its saved profile.
            sql`NOT EXISTS (SELECT 1 FROM ${followEdges} WHERE ${followEdges.followerId} = ${entities.id})`,
            sql`NOT EXISTS (SELECT 1 FROM ${followEdges} WHERE ${followEdges.followeeId} = ${entities.id})`,
          ),
        )
        .run()
  }
  releaseBlobs(tx, blobIds)
  return candidates.length
}

/**
 * Forget the blobs among these that no asset uses any more; their files,
 * and their thumbnails unless a removal mark keeps one, become garbage.
 * Returns the bytes released.
 */
export function releaseBlobs(tx: Transaction, blobIds: string[]): number {
  if (!blobIds.length) return 0
  const orphans = tx
    .select({
      id: blobs.id,
      hash: blobs.hash,
      size: blobs.size,
      thumbnail: blobThumbnails.key,
    })
    .from(blobs)
    .leftJoin(blobThumbnails, eq(blobThumbnails.blobId, blobs.id))
    .where(
      and(
        inJson(blobs.id, blobIds),
        sql`NOT EXISTS (SELECT 1 FROM ${assets} WHERE ${assets.blobId} = ${blobs.id})`,
      ),
    )
    .all()
  let released = 0
  for (const orphan of orphans) {
    tx.delete(blobs).where(eq(blobs.id, orphan.id)).run()
    released += orphan.size
    for (const key of [orphan.hash, orphan.thumbnail])
      if (key)
        tx.insert(mediaGarbage).values({ key }).onConflictDoNothing().run()
  }
  return released
}

/**
 * Raw responses of captures that changed nothing are kept for three days
 * and while their capture is the newest of its collection.
 */
export function pruneSourceResponses(ctx: CaptureContext): number {
  const cutoff = new Date(now(ctx) - RAW_KEEP)
  const superseded = ctx.db
    .select({ id: captures.id, collectionId: captures.collectionId })
    .from(captures)
    .where(
      and(
        captureSaved,
        lt(captures.finishedAt, cutoff),
        sql`EXISTS (SELECT 1 FROM ${sourceResponses} WHERE ${sourceResponses.captureId} = ${captures.id})`,
        sql`NOT EXISTS (SELECT 1 FROM ${revisions} WHERE ${revisions.captureId} = ${captures.id})`,
        sql`EXISTS (SELECT 1 FROM ${captures} newer WHERE newer.collection_id = ${captures.collectionId} AND newer.state IN ('complete', 'partial') AND (newer.finished_at > ${captures.finishedAt} OR (newer.finished_at = ${captures.finishedAt} AND newer.id > ${captures.id})))`,
      ),
    )
    .limit(PRUNE_BATCH)
    .all()
  if (superseded.length)
    ctx.db.transaction((tx) => {
      deleteSourceResponses(
        tx,
        superseded.map((row) => row.id),
        new Date(now(ctx)),
      )
      // Raw responses count toward storage.
      catalogCollections(
        tx,
        superseded.map((row) => row.collectionId),
      )
    })
  return superseded.length
}

/** Whether a media store key is in use, so its file stays. */
function keyUsed(tx: Transaction, key: string): boolean {
  return !!(
    tx.select({ id: blobs.id }).from(blobs).where(eq(blobs.hash, key)).get() ??
    tx
      .select({ id: blobThumbnails.blobId })
      .from(blobThumbnails)
      .where(eq(blobThumbnails.key, key))
      .get() ??
    // The thumbnail a removed media item (已移除) is still shown by.
    tx
      .select({ id: removedMedia.mediaKey })
      .from(removedMedia)
      .where(eq(removedMedia.thumbnailKey, key))
      .get()
  )
}

/**
 * Delete media files that stayed unreferenced past the grace period. A key
 * is claimed (`claimed_at`) in the transaction that finds it unused, before
 * its file is deleted: a restore in the web process, which holds no lock of
 * the worker's, links a file back only while its key is unclaimed
 * (`library/media-restore.ts`).
 */
export async function collectMedia(ctx: CaptureContext): Promise<number> {
  const at = now(ctx)
  const due = ctx.db
    .select()
    .from(mediaGarbage)
    .where(
      and(
        lte(mediaGarbage.since, new Date(at - MEDIA_GRACE)),
        or(
          isNull(mediaGarbage.retryAt),
          lte(mediaGarbage.retryAt, new Date(at)),
        ),
      ),
    )
    .limit(BATCH)
    .all()
  let deleted = 0
  const failures: unknown[] = []
  for (const garbage of due) {
    await ctx.mediaLocks.run(garbage.key, async () => {
      const claimed = ctx.db.transaction((tx) => {
        // Taken back meanwhile: restored, or downloaded again.
        const row = tx
          .select({ key: mediaGarbage.key })
          .from(mediaGarbage)
          .where(eq(mediaGarbage.key, garbage.key))
          .get()
        if (!row) return false
        if (keyUsed(tx, garbage.key)) {
          tx.delete(mediaGarbage).where(eq(mediaGarbage.key, garbage.key)).run()
          return false
        }
        tx.update(mediaGarbage)
          .set({ claimedAt: new Date(at) })
          .where(eq(mediaGarbage.key, garbage.key))
          .run()
        return true
      })
      if (!claimed) return
      try {
        await ctx.blobs.delete(garbage.key)
        deleted++
      } catch (error) {
        failures.push(new Error(`media ${garbage.key}: ${String(error)}`))
        const delay = Math.min(60_000 * 2 ** garbage.attempts, 24 * 60 * 60_000)
        // Still there: it may be restored until the next try.
        ctx.db
          .update(mediaGarbage)
          .set({
            attempts: garbage.attempts + 1,
            retryAt: new Date(at + delay),
            claimedAt: null,
          })
          .where(eq(mediaGarbage.key, garbage.key))
          .run()
        return
      }
      ctx.db.delete(mediaGarbage).where(eq(mediaGarbage.key, garbage.key)).run()
    })
  }
  if (failures.length) throw new AggregateError(failures, 'garbage media')
  return deleted
}

/** A thumbnail's pixel size from the start of its file; 0 when unreadable. */
async function sizeOf(ctx: CaptureContext, key: string) {
  try {
    const chunks: Buffer[] = []
    for await (const chunk of await ctx.blobs.read(key, {
      start: 0,
      end: HEADER_BYTES - 1,
    }))
      chunks.push(chunk as Buffer)
    return imageSize(Buffer.concat(chunks)) ?? { width: 0, height: 0 }
  } catch {
    return { width: 0, height: 0 }
  }
}

/**
 * Thumbnails made before their size was recorded get it now, read from the
 * file: batch after batch while the pass has time, a few at once. A file that
 * cannot be read is marked 0 by 0, as the web shows it without a size; a
 * regenerated thumbnail records its own.
 */
export async function backfillThumbnailSizes(
  ctx: CaptureContext,
): Promise<number> {
  const started = Date.now()
  let done = 0
  while (!sizesCaughtUp.has(ctx)) {
    const plain = ctx.db
      .select({ key: blobThumbnails.key })
      .from(blobThumbnails)
      .where(
        and(
          eq(blobThumbnails.state, 'ready'),
          isNotNull(blobThumbnails.key),
          isNull(blobThumbnails.width),
        ),
      )
      .limit(SIZE_BATCH)
      .all()
      .map((row) => row.key!)
    const removed = ctx.db
      .select({ key: removedMedia.thumbnailKey })
      .from(removedMedia)
      .where(
        and(
          isNotNull(removedMedia.thumbnailKey),
          isNull(removedMedia.thumbnailWidth),
        ),
      )
      .limit(SIZE_BATCH)
      .all()
      .map((row) => row.key!)
    const sizes = new Map<string, { width: number; height: number }>()
    const keys = [...new Set([...plain, ...removed])]
    for (let i = 0; i < keys.length; i += SIZE_READS)
      await Promise.all(
        keys.slice(i, i + SIZE_READS).map(async (key) => {
          sizes.set(key, await sizeOf(ctx, key))
        }),
      )
    ctx.db.transaction((tx) => {
      for (const key of plain)
        tx.update(blobThumbnails)
          .set(sizes.get(key)!)
          .where(and(eq(blobThumbnails.key, key), isNull(blobThumbnails.width)))
          .run()
      for (const key of removed) {
        const size = sizes.get(key)!
        tx.update(removedMedia)
          .set({ thumbnailWidth: size.width, thumbnailHeight: size.height })
          .where(
            and(
              eq(removedMedia.thumbnailKey, key),
              isNull(removedMedia.thumbnailWidth),
            ),
          )
          .run()
      }
    })
    done += plain.length + removed.length
    if (plain.length < SIZE_BATCH && removed.length < SIZE_BATCH)
      sizesCaughtUp.add(ctx)
    else if (Date.now() - started > SIZE_BUDGET) break
    // Batch after batch would keep the write lock from the web process.
    else await pace(ctx)
  }
  return done
}

/**
 * Fill the facets of rows catalogued before they existed, a batch at a
 * time, resuming where the last pass stopped (the progress is kept in
 * `settings` with each batch), while the worker has nothing else to do.
 * Returns the batches written.
 */
export async function backfillFacets(
  ctx: CaptureContext,
  idle: () => boolean = () => true,
  size = FACETS_BATCH,
): Promise<number> {
  const started = Date.now()
  let batches = 0
  while (
    !facetsCaughtUp.has(ctx) &&
    idle() &&
    Date.now() - started < FACETS_BUDGET
  ) {
    batches++
    if (!backfillBatch(ctx.db, size)) {
      facetsCaughtUp.add(ctx)
      ctx.logger.info({ batches }, 'facets filled')
      break
    }
    // Batch after batch would keep the write lock from the web process.
    await pace(ctx)
  }
  return batches
}

function pragma(ctx: CaptureContext, name: string): number {
  const row = ctx.db.$client.prepare(`PRAGMA ${name}`).get()
  return Number(Object.values(row ?? {})[0] ?? 0)
}

/**
 * Hand a bounded number of free pages back to the file system: deletions
 * leave pages free inside the file, and with `auto_vacuum = INCREMENTAL`
 * `incremental_vacuum` moves the last pages into free ones and truncates.
 * It is an ordinary write transaction, so Litestream replicates it like any
 * other, unlike VACUUM, which rewrites every page (see `db/client.ts`).
 * Returns the pages released.
 */
export function releaseFreePages(ctx: CaptureContext): number {
  const at = now(ctx)
  const last = vacuumedAt.get(ctx)
  if (last !== undefined && at - last < VACUUM_EVERY) return 0
  if (pragma(ctx, 'auto_vacuum') !== INCREMENTAL) return 0
  const free = pragma(ctx, 'freelist_count')
  if (free < VACUUM_MIN_FREE) return 0
  vacuumedAt.set(ctx, at)
  ctx.db.$client.exec(`PRAGMA incremental_vacuum(${VACUUM_PAGES})`)
  const left = pragma(ctx, 'freelist_count')
  ctx.logger.info(
    { released: free - left, free: left, pages: pragma(ctx, 'page_count') },
    'released free database pages',
  )
  return free - left
}
