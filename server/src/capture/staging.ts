import { eq, sql } from 'drizzle-orm'
import { captures, captureStaging } from '#db/schema.ts'
import type { Executor, Transaction } from '#db/client.ts'
import type { CaptureContext } from './context.ts'
import type { Payload } from './payload.ts'
import type { Buffer } from 'node:buffer'

// A capture's staged data outlives it only for a listing whose targets were
// never submitted (stopped, or its related step failed); prefetches are of
// no use after an hour (see the X strategy), so a day is ample.
const STAGING_KEEP = 24 * 60 * 60_000

export type Staging = typeof captureStaging.$inferSelect

export function loadStaging(
  executor: Executor,
  captureId: string,
): Staging | undefined {
  return executor
    .select()
    .from(captureStaging)
    .where(eq(captureStaging.captureId, captureId))
    .get()
}

/** What the listing that created a capture already read of its target. */
export function stagePrefetch(
  tx: Transaction,
  captureId: string,
  prefetch: Buffer,
): void {
  tx.insert(captureStaging).values({ captureId, prefetch }).run()
}

/**
 * Keep a fetch's result for finalize, and the prefetches of the targets it
 * listed for submitting them; the listing's own prefetch has served.
 */
export function stageResult(
  tx: Transaction,
  captureId: string,
  payload: Payload,
  targetPrefetch: (string | null)[] | null,
): void {
  tx.insert(captureStaging)
    .values({ captureId, payload, targetPrefetch })
    .onConflictDoUpdate({
      target: captureStaging.captureId,
      set: { prefetch: null, payload, targetPrefetch },
    })
    .run()
}

/**
 * Finalize used the result: drop it, and the whole row unless target
 * prefetches still wait for the related step.
 */
export function settleStaging(tx: Transaction, staging: Staging): void {
  if (staging.targetPrefetch)
    tx.update(captureStaging)
      .set({ payload: null })
      .where(eq(captureStaging.captureId, staging.captureId))
      .run()
  else dropStaging(tx, staging.captureId)
}

export function dropStaging(executor: Executor, captureId: string): void {
  executor
    .delete(captureStaging)
    .where(eq(captureStaging.captureId, captureId))
    .run()
}

/** Staged data of captures that finished a day ago and more. */
export function pruneStaging(ctx: CaptureContext): number {
  const cutoff = new Date((ctx.now?.() ?? Date.now()) - STAGING_KEEP)
  // The table is small: walk it and look each capture up.
  const { changes } = ctx.db
    .delete(captureStaging)
    .where(
      sql`EXISTS (SELECT 1 FROM ${captures} WHERE ${captures.id} = ${captureStaging.captureId} AND ${captures.state} IN ('complete', 'partial', 'failed') AND ${captures.finishedAt} < ${cutoff.getTime()})`,
    )
    .run()
  return Number(changes)
}
