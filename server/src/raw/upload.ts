import { and, asc, eq, isNull, lte, or } from 'drizzle-orm'
import { rawGarbage, sourceResponses } from '#db/schema.ts'
import {
  PermanentError,
  RetryError,
  SnoozeError,
  type Job,
} from '#jobs/queue.ts'
import { localRows, markStored, storedBefore } from './responses.ts'
import { CorruptRawError, RawRateLimitError, type RawStore } from './store.ts'
import type { CaptureContext } from '#capture/context.ts'
import type { Transaction } from '#db/client.ts'

// Out of attempts after about seven hours; `raw-migrate` stores what is
// left over, which stays in the database meanwhile.
export const RAW_ATTEMPTS = 12
const FIRST_RETRY = 30_000
const LONGEST_RETRY = 60 * 60_000
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
 * clearing them: written and read back first, cleared after. Under the
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
      body: sourceResponses.body,
    })
    .from(sourceResponses)
    .where(
      and(
        eq(sourceResponses.captureId, job.ref),
        isNull(sourceResponses.remoteAt),
      ),
    )
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
      if (error instanceof CorruptRawError)
        throw new PermanentError(String(error), { cause: error })
      throw new RetryError(
        `raw response upload failed: ${String(error)}`,
        Math.min(FIRST_RETRY * 2 ** (job.attempt - 1), LONGEST_RETRY),
        { cause: error },
      )
    }
  }
}

export function failRawUpload(
  ctx: CaptureContext,
  captureId: string,
  error: unknown,
): void {
  ctx.logger.error(
    { captureId, err: error },
    'raw response upload gave up; the bodies stay in the database',
  )
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
          failures.push(new Error(`raw ${garbage.key}: ${String(error)}`))
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
