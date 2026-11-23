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
  jobs,
  library,
  mediaGarbage,
  revisionEntities,
  revisions,
  sourceResponses,
  submissions,
} from '#db/schema.ts'
import { catalogCollections } from '#library/catalog.ts'
import { failCapture } from './lifecycle.ts'
import type { Transaction } from '#db/client.ts'
import type { CaptureContext } from './context.ts'

const STALE_CAPTURE = 60 * 60_000
const RAW_KEEP = 7 * 24 * 60 * 60_000
const MEDIA_GRACE = 24 * 60 * 60_000
const BATCH = 100
const THUMBNAIL_BACKFILL = 2000
const PRUNE_BATCH = 500

const thumbnailsCaughtUp = new WeakSet<CaptureContext>()
const BUDGET = 30_000

/** One maintenance pass. Steps are independent; errors are collected. */
export async function runMaintenance(ctx: CaptureContext): Promise<void> {
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
  await step('collections', () => collectCollections(ctx))
  await step('raw responses', () => pruneSourceResponses(ctx))
  await step('media', () => collectMedia(ctx))
  await step('thumbnails', () => backfillThumbnails(ctx))
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
    ctx.db.transaction((tx) =>
      failCapture(ctx, tx, id, 'capture was interrupted'),
    )
  return stale.length
}

/**
 * Remove collections nothing saves any more, once no capture of them is
 * running, with everything only they used.
 */
export function collectCollections(ctx: CaptureContext): number {
  const started = Date.now()
  let removed = 0
  for (;;) {
    const count = ctx.db.transaction((tx) => collectBatch(tx))
    removed += count
    if (count < BATCH || Date.now() - started > BUDGET) return removed
  }
}

function collectBatch(tx: Transaction): number {
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
          sql`${entityVersions.id} IN (SELECT value FROM json_each(${JSON.stringify(versionIds)}))`,
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
            sql`${entities.id} IN (SELECT value FROM json_each(${JSON.stringify(entityIds)}))`,
            sql`NOT EXISTS (SELECT 1 FROM ${entityVersions} WHERE ${entityVersions.entityId} = ${entities.id})`,
          ),
        )
        .run()
  }
  if (blobIds.length) {
    const orphans = tx
      .select({ id: blobs.id, hash: blobs.hash, thumbnail: blobThumbnails.key })
      .from(blobs)
      .leftJoin(blobThumbnails, eq(blobThumbnails.blobId, blobs.id))
      .where(
        and(
          inArray(blobs.id, blobIds),
          sql`NOT EXISTS (SELECT 1 FROM ${assets} WHERE ${assets.blobId} = ${blobs.id})`,
        ),
      )
      .all()
    for (const orphan of orphans) {
      tx.delete(blobs).where(eq(blobs.id, orphan.id)).run()
      for (const key of [orphan.hash, orphan.thumbnail])
        if (key)
          tx.insert(mediaGarbage).values({ key }).onConflictDoNothing().run()
    }
  }
  return candidates.length
}

/**
 * Raw responses of captures that changed nothing are kept for a week and
 * while their capture is the newest of its collection.
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
      tx.delete(sourceResponses)
        .where(
          inArray(
            sourceResponses.captureId,
            superseded.map((row) => row.id),
          ),
        )
        .run()
      // Raw responses count toward storage.
      catalogCollections(
        tx,
        superseded.map((row) => row.collectionId),
      )
    })
  return superseded.length
}

/** Delete media files that stayed unreferenced past the grace period. */
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
      const used =
        ctx.db
          .select({ id: blobs.id })
          .from(blobs)
          .where(eq(blobs.hash, garbage.key))
          .get() ??
        ctx.db
          .select({ id: blobThumbnails.blobId })
          .from(blobThumbnails)
          .where(eq(blobThumbnails.key, garbage.key))
          .get()
      if (!used) {
        try {
          await ctx.blobs.delete(garbage.key)
          deleted++
        } catch (error) {
          failures.push(new Error(`media ${garbage.key}: ${String(error)}`))
          const delay = Math.min(
            60_000 * 2 ** garbage.attempts,
            24 * 60 * 60_000,
          )
          ctx.db
            .update(mediaGarbage)
            .set({
              attempts: garbage.attempts + 1,
              retryAt: new Date(at + delay),
            })
            .where(eq(mediaGarbage.key, garbage.key))
            .run()
          return
        }
      }
      ctx.db.delete(mediaGarbage).where(eq(mediaGarbage.key, garbage.key)).run()
    })
  }
  if (failures.length) throw new AggregateError(failures, 'garbage media')
  return deleted
}

/** Blobs stored before thumbnails were possible get one now. */
export function backfillThumbnails(ctx: CaptureContext): number {
  // New media get thumbnails as they are downloaded; only what predates the
  // thumbnailer (it is detected at start) is missing, so stop once caught up
  // instead of scanning every blob each minute.
  if (!ctx.thumbnailer || thumbnailsCaughtUp.has(ctx)) return 0
  const missing = ctx.db
    .select({ id: blobs.id })
    .from(blobs)
    .where(
      and(
        sql`NOT EXISTS (SELECT 1 FROM ${blobThumbnails} WHERE ${blobThumbnails.blobId} = ${blobs.id})`,
        sql`NOT EXISTS (SELECT 1 FROM ${jobs} WHERE ${jobs.type} = 'thumbnail' AND ${jobs.ref} = ${blobs.id})`,
      ),
    )
    .limit(THUMBNAIL_BACKFILL)
    .all()
  ctx.db.transaction((tx) => {
    for (const { id } of missing) ctx.queue.enqueue(tx, 'thumbnail', id)
  })
  if (missing.length < THUMBNAIL_BACKFILL) thumbnailsCaughtUp.add(ctx)
  return missing.length
}
