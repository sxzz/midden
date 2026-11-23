import { and, eq, inArray } from 'drizzle-orm'
import {
  assets,
  captures,
  connections,
  sourceResponses,
  submissions,
} from '#db/schema.ts'
import { AppError } from '#errors.ts'
import type { Transaction } from '#db/client.ts'
import type { CaptureContext } from './context.ts'

type Capture = typeof captures.$inferSelect

export function loadCapture(tx: Transaction, id: string): Capture | undefined {
  return tx.select().from(captures).where(eq(captures.id, id)).get()
}

export function isActive(capture: Capture): boolean {
  return capture.state === 'queued' || capture.state === 'downloading'
}

/**
 * The account a capture fetched with must still be the one stored: a
 * rotated or revoked credential discards the work done with the old one.
 */
export function validateExecution(
  tx: Transaction,
  capture: Pick<Capture, 'connectionId' | 'credentialRevision'>,
  revision = capture.credentialRevision,
): void {
  if (!capture.connectionId) return
  const connection = tx
    .select({ state: connections.state, revision: connections.revision })
    .from(connections)
    .where(eq(connections.id, capture.connectionId))
    .get()
  if (
    connection?.state !== 'ready' ||
    revision === null ||
    connection.revision !== revision
  )
    throw new AppError('connection')
}

/** Queue finalize once no asset of the capture is still pending. */
export function finalizeSettled(
  ctx: CaptureContext,
  tx: Transaction,
  captureId: string,
): void {
  const pending = tx
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.captureId, captureId), eq(assets.state, 'pending')))
    .get()
  if (!pending) ctx.queue.enqueue(tx, 'finalize', captureId)
}

/**
 * A capture reached a terminal state: start the related work of everyone
 * waiting on it now instead of at their fallback time.
 */
export function deliveries(
  ctx: CaptureContext,
  tx: Transaction,
  captureId: string,
): void {
  const waiting = tx
    .select({ id: submissions.id })
    .from(submissions)
    .where(
      and(
        eq(submissions.captureId, captureId),
        eq(submissions.relatedState, 'pending'),
        eq(submissions.collectionStopped, false),
      ),
    )
    .all()
  for (const { id } of waiting) ctx.queue.enqueue(tx, 'related', id)
}

/** Fail an unfinished capture; a finished one is left as it is. */
export function failCapture(
  ctx: CaptureContext,
  tx: Transaction,
  captureId: string,
  message: string,
): void {
  const capture = loadCapture(tx, captureId)
  if (!capture || !isActive(capture)) return
  tx.update(assets)
    .set({ state: 'failed', error: message })
    .where(and(eq(assets.captureId, captureId), eq(assets.state, 'pending')))
    .run()
  tx.delete(sourceResponses)
    .where(eq(sourceResponses.captureId, captureId))
    .run()
  tx.update(captures)
    .set({
      state: 'failed',
      error: message,
      prefetch: null,
      payload: null,
      finishedAt: new Date(ctx.now?.() ?? Date.now()),
    })
    .where(
      and(
        eq(captures.id, captureId),
        inArray(captures.state, ['queued', 'downloading']),
      ),
    )
    .run()
  deliveries(ctx, tx, captureId)
}
