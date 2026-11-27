import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import { newId } from '#db/id.ts'
import { collections, collectionStates, library } from '#db/schema.ts'
import { RANK, type Job } from '#jobs/queue.ts'
import { submit } from './submit.ts'
import type { Executor } from '#db/client.ts'
import type { CaptureContext } from './context.ts'

export type SourceState = 'deleted' | 'suspended'

/**
 * When a first answer that is not explicit is asked again. The public
 * instance answers "not found" for its own failed lookups too, so one such
 * answer marks nothing; one an hour later that agrees does.
 */
export const RECHECK_MS = 60 * 60_000
/** How far apart two answers must be to confirm each other. */
export const CONFIRM_GAP_MS = 50 * 60_000

/** Ties a re-check's capture to the first answer it checks. */
export const RECHECK_KEY = 'source-check:'

export type Observed =
  /** Already confirmed: nothing new, and nothing failed. */
  | 'known'
  /** Confirmed by this answer. */
  | 'confirmed'
  /** Waiting for a second answer. */
  | 'pending'

/**
 * Record what a capture's platform said of a collection that is gone. An
 * explicit answer (the account's own view of a tombstone or suspension)
 * confirms at once; any other confirms an earlier one of the same state at
 * least CONFIRM_GAP_MS older, else waits for a re-check RECHECK_MS later.
 */
export function observeSourceState(
  ctx: CaptureContext,
  collectionId: string,
  state: SourceState,
  explicit: boolean,
): Observed {
  const now = new Date(ctx.now?.() ?? Date.now())
  return ctx.db.transaction((tx) => {
    const open = tx
      .select()
      .from(collectionStates)
      .where(
        and(
          eq(collectionStates.collectionId, collectionId),
          isNull(collectionStates.endedAt),
        ),
      )
      .orderBy(desc(collectionStates.since))
      .all()
    const current = open.find((row) => row.confirmedAt)
    const pending = open.find((row) => !row.confirmedAt)
    // A pending answer that disagrees is dropped for this one.
    if (pending && pending.state !== state)
      tx.delete(collectionStates)
        .where(eq(collectionStates.id, pending.id))
        .run()
    if (current?.state === state) {
      tx.update(collectionStates)
        .set({ seenAt: now })
        .where(eq(collectionStates.id, current.id))
        .run()
      return 'known'
    }
    const agreeing = pending?.state === state ? pending : undefined
    if (
      explicit ||
      (agreeing && now.getTime() - agreeing.since.getTime() >= CONFIRM_GAP_MS)
    ) {
      const since = agreeing?.since ?? now
      if (current)
        tx.update(collectionStates)
          .set({ endedAt: now })
          .where(eq(collectionStates.id, current.id))
          .run()
      if (agreeing)
        tx.update(collectionStates)
          .set({ confirmedAt: now, seenAt: now })
          .where(eq(collectionStates.id, agreeing.id))
          .run()
      else
        tx.insert(collectionStates)
          .values({
            id: newId(),
            collectionId,
            state,
            since,
            confirmedAt: now,
            seenAt: now,
          })
          .run()
      tx.update(collections)
        .set({ sourceState: state, sourceStateAt: since })
        .where(eq(collections.id, collectionId))
        .run()
      return 'confirmed'
    }
    if (agreeing) {
      tx.update(collectionStates)
        .set({ seenAt: now })
        .where(eq(collectionStates.id, agreeing.id))
        .run()
      return 'pending'
    }
    const id = newId()
    tx.insert(collectionStates)
      .values({ id, collectionId, state, since: now, seenAt: now })
      .run()
    // Background work of its own, run by the worker: not part of an update
    // the capture may belong to, and after what someone waits for.
    ctx.queue.enqueue(tx, 'source-check', id, {
      delayMs: RECHECK_MS,
      updateId: null,
      rank: RANK.maintenance,
    })
    return 'pending'
  })
}

/**
 * The content was read normally: an answer still waiting was wrong, and a
 * confirmed state is over. The collection itself is updated by the caller.
 */
export function endSourceStates(
  tx: Executor,
  collectionIds: readonly string[],
  now: Date,
): void {
  if (!collectionIds.length) return
  const ids = [...collectionIds]
  tx.delete(collectionStates)
    .where(
      and(
        inArray(collectionStates.collectionId, ids),
        isNull(collectionStates.confirmedAt),
      ),
    )
    .run()
  tx.update(collectionStates)
    .set({ endedAt: now })
    .where(
      and(
        inArray(collectionStates.collectionId, ids),
        isNotNull(collectionStates.confirmedAt),
        isNull(collectionStates.endedAt),
      ),
    )
    .run()
}

/**
 * Ask again about a first answer still waiting: capture the collection the
 * way an automatic refresh does, without its timeline or lists.
 */
export function runSourceCheck(ctx: CaptureContext, job: Job): void {
  const row = ctx.db
    .select({ collectionId: collectionStates.collectionId })
    .from(collectionStates)
    .innerJoin(library, eq(library.collectionId, collectionStates.collectionId))
    .where(
      and(
        eq(collectionStates.id, job.ref),
        isNull(collectionStates.confirmedAt),
        isNull(collectionStates.endedAt),
      ),
    )
    .get()
  if (!row) return
  submit(ctx, {
    refreshId: row.collectionId,
    automatic: true,
    key: `${RECHECK_KEY}${job.ref}`,
  })
}

/** A collection's states, oldest first, confirmed ones only. */
export function stateHistory(
  r: Pick<CaptureContext, 'db'>,
  collectionId: string,
): { state: SourceState; since: Date; endedAt: Date | null }[] {
  return r.db
    .select({
      state: collectionStates.state,
      since: collectionStates.since,
      endedAt: collectionStates.endedAt,
    })
    .from(collectionStates)
    .where(
      and(
        eq(collectionStates.collectionId, collectionId),
        isNotNull(collectionStates.confirmedAt),
      ),
    )
    .orderBy(collectionStates.since, collectionStates.id)
    .all()
}

export { knownGoneSQL } from './retry-units.ts'

/** The state a failed capture saw again, as `knownGoneSQL` tells it. */
export function knownGone(
  capture: { state: string; finishedAt: Date | null; createdAt: Date },
  collection: { sourceState: SourceState | null; sourceStateAt: Date | null },
): SourceState | undefined {
  if (
    capture.state !== 'failed' ||
    !collection.sourceState ||
    !collection.sourceStateAt
  )
    return
  const at = (capture.finishedAt ?? capture.createdAt).getTime()
  return at >= collection.sourceStateAt.getTime()
    ? collection.sourceState
    : undefined
}
