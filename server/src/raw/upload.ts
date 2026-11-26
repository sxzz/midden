import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm'
import { isBusy, type Transaction } from '#db/client.ts'
import {
  captures,
  jobs,
  rawGarbage,
  rawUploadFailures,
  sourceResponseBodies,
  sourceResponses,
} from '#db/schema.ts'
import { RetryError, SnoozeError, type Job } from '#jobs/queue.ts'
import {
  isLocal,
  localRows,
  markStored,
  notCorrupt,
  storedBefore,
} from './responses.ts'
import { CorruptRawError, RawRateLimitError, type RawStore } from './store.ts'
import type { CaptureContext } from '#capture/context.ts'

// Out of attempts after about seven hours; the sweep queues what is left
// over again later, which stays in the database meanwhile.
export const RAW_ATTEMPTS = 12
const FIRST_RETRY = 30_000
const LONGEST_RETRY = 60 * 60_000
const BUSY_WAIT = 2000
// New captures queue their own upload; the sweep looks for bodies an hour
// old, which no job moved.
const SWEEP_GRACE = 60 * 60_000
const SWEEP_QUEUED = 500
// After a job gave up: an hour, doubling with each time, at most a day.
const SWEEP_RETRY = 60 * 60_000
const SWEEP_LONGEST_RETRY = 24 * 60 * 60_000
// Objects stay a day after their last row went, as media files do: a
// database restored to a moment before still finds them.
const RAW_GRACE = 24 * 60 * 60_000
const BATCH = 100

/**
 * The lock a body's upload and its garbage collection share, in the media
 * locks: collection checks that no row uses a key and deletes the object
 * while an upload cannot be storing it for a new row.
 */
export const rawLock = (sha256: string) => `raw:${sha256}`

const now = (ctx: CaptureContext) => new Date(ctx.now?.() ?? Date.now())

/** Move a finished capture's raw responses to the bucket, if there is one. */
export function enqueueRawUpload(
  ctx: CaptureContext,
  tx: Transaction,
  captureId: string,
): void {
  if (!ctx.raw) return
  const any = tx
    .select({ id: sourceResponses.id })
    .from(sourceResponses)
    .where(eq(sourceResponses.captureId, captureId))
    .get()
  if (any) ctx.queue.enqueue(tx, 'raw-upload', captureId)
}

/**
 * Store one body in the bucket and record every row holding it here,
 * deleting their bodies: written and read back first, deleted after. Under the
 * key's lock, so no two jobs store one key at once (R2 rejects writes to a
 * key faster than about one a second); a job that finds its row recorded
 * by another meanwhile has nothing left to do, and one whose body another
 * row stored before only checks the object. Returns the rows recorded.
 */
export function storeResponse(
  ctx: CaptureContext,
  raw: RawStore,
  row: { id: string; sha256: string; body: Uint8Array },
  signal?: AbortSignal,
): Promise<number> {
  return ctx.mediaLocks.run(rawLock(row.sha256), async () => {
    const rows = localRows(ctx.db, row.sha256)
    if (rows.every((local) => local.id !== row.id)) return 0
    await raw.store(row.sha256, row.body, {
      check: storedBefore(ctx.db, row.sha256),
      signal,
    })
    return markStored(ctx.db, rows, now(ctx))
  })
}

/** An error with its causes: Drizzle keeps SQLite's error in `cause`. */
export function describe(error: unknown): string {
  const parts: string[] = []
  for (let e = error; e !== undefined && parts.length < 5;) {
    parts.push(e instanceof Error ? e.message : String(e))
    e = e instanceof Error ? e.cause : undefined
  }
  return parts.join(': ')
}

/**
 * A body that does not match its hash: recorded so that nothing tries it
 * again, and logged this once. Its bytes stay as they are.
 */
function markCorrupt(
  ctx: CaptureContext,
  row: { id: string; sha256: string },
  error: unknown,
): void {
  ctx.db
    .insert(rawUploadFailures)
    .values({ responseId: row.id, failures: 1, error: describe(error) })
    .onConflictDoUpdate({
      target: rawUploadFailures.responseId,
      set: { retryAt: null, error: describe(error) },
    })
    .run()
  ctx.logger.error(
    { responseId: row.id, sha256: row.sha256, err: error },
    'raw response does not match its hash; it stays in the database and is not retried',
  )
}

/** The raw upload job: every body of the capture not yet in the bucket. */
export async function runRawUpload(
  ctx: CaptureContext,
  job: Job,
): Promise<void> {
  const raw = ctx.raw
  if (!raw) return
  // Waiting out the bucket's pause is no attempt.
  const paused = raw.pausedFor()
  if (paused) throw new SnoozeError(paused)
  const rows = ctx.db
    .select({
      id: sourceResponses.id,
      sha256: sourceResponses.sha256,
      body: sourceResponseBodies.body,
    })
    .from(sourceResponses)
    .innerJoin(
      sourceResponseBodies,
      eq(sourceResponseBodies.responseId, sourceResponses.id),
    )
    .where(and(eq(sourceResponses.captureId, job.ref), notCorrupt))
    .orderBy(asc(sourceResponses.position))
    .all()
  for (const row of rows) {
    try {
      await storeResponse(ctx, raw, row, job.signal)
    } catch (error) {
      if (job.signal.aborted) throw error
      if (error instanceof RawRateLimitError) {
        if (error.started)
          ctx.logger.warn(
            { afterMs: error.afterMs, err: error.cause },
            'raw bucket rate-limited; pausing raw uploads',
          )
        throw new SnoozeError(error.afterMs)
      }
      // The capture's other bodies go on; this one is never retried.
      if (error instanceof CorruptRawError) {
        markCorrupt(ctx, row, error)
        continue
      }
      // The write lock stayed taken: waiting for it is no attempt.
      if (isBusy(error)) throw new SnoozeError(BUSY_WAIT)
      throw new RetryError(
        `raw response upload failed: ${describe(error)}`,
        Math.min(FIRST_RETRY * 2 ** (job.attempt - 1), LONGEST_RETRY),
        { cause: error },
      )
    }
  }
}

/**
 * The job ran out of attempts (or failed outright): its bodies stay here,
 * and the sweep queues them again later, waiting longer after each time
 * (one hour, then doubling, at most a day), so a long outage of the bucket
 * heals by itself.
 */
export function failRawUpload(
  ctx: CaptureContext,
  captureId: string,
  error: unknown,
): void {
  const at = now(ctx).getTime()
  const message = describe(error)
  ctx.db.transaction((tx) => {
    const rows = tx
      .select({
        id: sourceResponses.id,
        failures: rawUploadFailures.failures,
      })
      .from(sourceResponses)
      .leftJoin(
        rawUploadFailures,
        eq(rawUploadFailures.responseId, sourceResponses.id),
      )
      .where(and(eq(sourceResponses.captureId, captureId), isLocal, notCorrupt))
      .all()
    for (const row of rows) {
      const failures = (row.failures ?? 0) + 1
      const retryAt = new Date(
        at + Math.min(SWEEP_RETRY * 2 ** (failures - 1), SWEEP_LONGEST_RETRY),
      )
      tx.insert(rawUploadFailures)
        .values({ responseId: row.id, failures, retryAt, error: message })
        .onConflictDoUpdate({
          target: rawUploadFailures.responseId,
          set: { failures, retryAt, error: message },
        })
        .run()
    }
  })
  ctx.logger.error(
    { captureId, err: error },
    'raw response upload gave up; the bodies stay in the database until the sweep queues them again',
  )
}

/**
 * Queue the upload of raw responses that are still here an hour after
 * their capture finished and that no job is moving: ones from before the
 * bucket was configured, from a job that gave up (once its wait is over),
 * or from a job that got lost. A capture's job moves all its bodies. At
 * most `SWEEP_QUEUED` such jobs wait at a time, so a large backlog drains
 * at the pace the worker gives the `raw` queue (idle-only, throttled, at
 * maintenance rank). Returns the captures queued.
 */
export function sweepRawUploads(ctx: CaptureContext): number {
  if (!ctx.raw) return 0
  const at = now(ctx).getTime()
  const waiting = ctx.db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(jobs)
    .where(and(eq(jobs.queue, 'raw'), eq(jobs.type, 'raw-upload')))
    .get()!.n
  const room = SWEEP_QUEUED - waiting
  if (room <= 0) return 0
  // From the bodies: they are the rows still here, and only those.
  const captureIds = ctx.db
    .all<{ id: string }>(
      sql`
      SELECT DISTINCT sr.capture_id AS id
      FROM ${sourceResponseBodies} b
      CROSS JOIN ${sourceResponses} sr ON sr.id = b.response_id
      WHERE sr.created_at <= ${at - SWEEP_GRACE}
        AND NOT EXISTS (SELECT 1 FROM ${rawUploadFailures} f
          WHERE f.response_id = sr.id AND (f.retry_at IS NULL OR f.retry_at > ${at}))
        AND NOT EXISTS (SELECT 1 FROM ${jobs} j
          WHERE j.ref = sr.capture_id AND j.type = 'raw-upload')
        AND EXISTS (SELECT 1 FROM ${captures} c
          WHERE c.id = sr.capture_id AND c.state IN ('complete', 'partial'))
      LIMIT ${room}`,
    )
    .map((row) => row.id)
  if (!captureIds.length) return 0
  ctx.db.transaction((tx) => {
    for (const id of captureIds) ctx.queue.enqueue(tx, 'raw-upload', id)
  })
  ctx.logger.info(
    { captures: captureIds.length },
    'queued raw responses still in the database for upload',
  )
  return captureIds.length
}

/**
 * Delete the objects of raw responses no row uses any more, a day after
 * their last row went. A key used again meanwhile (the same body fetched
 * once more) is kept. Returns the objects deleted.
 */
export async function collectRawGarbage(ctx: CaptureContext): Promise<number> {
  const raw = ctx.raw
  if (!raw) return 0
  const at = now(ctx).getTime()
  const due = ctx.db
    .select()
    .from(rawGarbage)
    .where(
      and(
        lte(rawGarbage.since, new Date(at - RAW_GRACE)),
        or(isNull(rawGarbage.retryAt), lte(rawGarbage.retryAt, new Date(at))),
      ),
    )
    .limit(BATCH)
    .all()
  let deleted = 0
  const failures: unknown[] = []
  for (const garbage of due)
    await ctx.mediaLocks.run(rawLock(garbage.key), async () => {
      const used = ctx.db
        .select({ id: sourceResponses.id })
        .from(sourceResponses)
        .where(eq(sourceResponses.sha256, garbage.key))
        .get()
      if (!used) {
        try {
          await raw.delete(garbage.key)
          deleted++
        } catch (error) {
          // The bucket is pausing: the next pass tries again, no attempt lost.
          if (error instanceof RawRateLimitError) return
          failures.push(
            new Error(`raw ${garbage.key}: ${describe(error)}`, {
              cause: error,
            }),
          )
          ctx.db
            .update(rawGarbage)
            .set({
              attempts: garbage.attempts + 1,
              retryAt: new Date(
                at + Math.min(60_000 * 2 ** garbage.attempts, RAW_GRACE),
              ),
            })
            .where(eq(rawGarbage.key, garbage.key))
            .run()
          return
        }
      }
      ctx.db.delete(rawGarbage).where(eq(rawGarbage.key, garbage.key)).run()
    })
  if (failures.length) throw new AggregateError(failures, 'raw garbage')
  return deleted
}
