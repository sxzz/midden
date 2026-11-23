import { and, eq, gte, inArray, like, lt } from 'drizzle-orm'
import { newId } from '#db/id.ts'
import {
  captures,
  collections,
  library,
  refreshBatches,
  submissions,
} from '#db/schema.ts'
import { inJson } from '#db/sql.ts'
import { AppError, isAppError } from '#errors.ts'
import {
  collectionProgresses,
  retryFailed,
  type CollectionProgress,
  type MemberProgress,
} from './records.ts'
import { submit } from './submit.ts'
import type { Executor } from '#db/client.ts'
import type { Job } from '#jobs/queue.ts'
import type { CaptureContext } from './context.ts'
import type { StoredTarget } from './related.ts'

const MAX_BATCH = 500
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i
const BATCH_LIFETIME = 24 * 60 * 60_000

/** Refresh many saved collections in the background. */
export function startRefreshBatch(ctx: CaptureContext, ids: string[]) {
  if (ids.some((id) => !UUID.test(id))) throw new AppError('unsupported')
  const unique = [...new Set(ids)]
  if (unique.length === 0 || unique.length > MAX_BATCH)
    throw new AppError('unsupported')
  const id = ctx.db.transaction((tx) => {
    const saved = tx
      .select({ id: library.collectionId })
      .from(library)
      .where(inArray(library.collectionId, unique))
      .all()
    if (saved.length !== unique.length) throw new AppError('not_found')
    const batchId = newId()
    tx.insert(refreshBatches)
      .values({ id: batchId, collectionIds: unique })
      .run()
    ctx.queue.enqueue(tx, 'refresh_batch', batchId)
    return batchId
  })
  return batchProgress(ctx.db, id)
}

export function runRefreshBatch(ctx: CaptureContext, job: Job): void {
  const { db } = ctx
  const batch = db
    .select()
    .from(refreshBatches)
    .where(eq(refreshBatches.id, job.ref))
    .get()
  if (batch?.state !== 'running') return
  const now = ctx.now?.() ?? Date.now()
  if (batch.createdAt.getTime() < now - BATCH_LIFETIME) {
    failRefreshBatch(ctx, batch.id, 'capture service unavailable')
    return
  }
  for (
    let position = batch.position;
    position < batch.collectionIds.length;
    position++
  ) {
    const collectionId = batch.collectionIds[position]!
    let job: { id: string; state: string } | undefined
    const saved = db
      .select({ id: library.collectionId })
      .from(library)
      .where(eq(library.collectionId, collectionId))
      .get()
    if (saved) {
      try {
        job = submit(ctx, {
          refreshId: collectionId,
          key: `refresh-batch:${batch.id}:${position}`,
        })
      } catch (error) {
        if (
          !isAppError(error) ||
          !['not_found', 'unsupported', 'connection'].includes(error.kind)
        )
          throw error
      }
    }
    // Record each item as it goes, so a replay never submits twice.
    db.transaction((tx) => {
      const current = tx
        .select()
        .from(refreshBatches)
        .where(eq(refreshBatches.id, batch.id))
        .get()
      if (current?.position !== position) return
      tx.update(refreshBatches)
        .set(
          job
            ? {
                position: position + 1,
                reused:
                  current.reused +
                  (job.state === 'queued' || job.state === 'downloading'
                    ? 0
                    : 1),
                captureIds: [...current.captureIds, job.id],
              }
            : { position: position + 1, rejected: current.rejected + 1 },
        )
        .where(eq(refreshBatches.id, batch.id))
        .run()
    })
  }
  db.update(refreshBatches)
    .set({ state: 'complete' })
    .where(
      and(eq(refreshBatches.id, batch.id), eq(refreshBatches.state, 'running')),
    )
    .run()
}

export function failRefreshBatch(
  ctx: CaptureContext,
  id: string,
  message: string,
): void {
  ctx.db
    .update(refreshBatches)
    .set({ state: 'failed', error: message })
    .where(and(eq(refreshBatches.id, id), eq(refreshBatches.state, 'running')))
    .run()
}

export interface BatchItem {
  url: string
  collectionId: string
  running: boolean
  members?: MemberProgress
}

export interface BatchProgress {
  id: string
  state: string
  error: string
  total: number
  submitted: number
  reused: number
  rejected: number
  running: number
  complete: number
  partial: number
  failed: number
  members: MemberProgress
  retryable: number
  done: boolean
  active: BatchItem[]
}

/** The collection roots a batch submitted, as record ids. */
function batchRoots(db: Executor, id: string) {
  return (
    db
      .select({
        submission: submissions,
        capture: captures,
        url: collections.url,
      })
      .from(submissions)
      .innerJoin(captures, eq(captures.id, submissions.captureId))
      .innerJoin(collections, eq(collections.id, captures.collectionId))
      // A key range rather than LIKE, which is case-insensitive and so cannot
      // use the unique index on the key. ';' follows ':'.
      .where(
        and(
          gte(submissions.idemKey, `refresh-batch:${id}:`),
          lt(submissions.idemKey, `refresh-batch:${id};`),
        ),
      )
      .all()
  )
}

export function batchProgress(db: Executor, id: string): BatchProgress {
  const batch = db
    .select()
    .from(refreshBatches)
    .where(eq(refreshBatches.id, id))
    .get()
  if (!batch) throw new AppError('not_found')
  const states = batch.captureIds.length
    ? db
        .select({ id: captures.id, state: captures.state })
        .from(captures)
        .where(inArray(captures.id, batch.captureIds))
        .all()
    : []
  const stateOf = new Map(states.map((s) => [s.id, s.state]))
  const count = (test: (state: string) => boolean) =>
    batch.captureIds.filter((c) => test(stateOf.get(c) ?? '')).length
  const isRunning = (state: string) =>
    state === 'queued' || state === 'downloading'

  const roots = batchRoots(db, id)
    .filter((root) => root.capture.isCollection)
    .toSorted((a, b) => {
      const position = (key: string) => Number(key.split(':').at(-1))
      return position(a.submission.idemKey) - position(b.submission.idemKey)
    })
  const byRoot = collectionProgresses(
    db,
    roots.map((root) => root.submission.id),
  )
  const progresses = roots.map((root) => ({
    root,
    progress: byRoot.get(root.submission.id)!,
  }))
  const urls = new Set<string>()
  const members = new Map<string, string>()
  let pagePending = false
  const pageIds: string[] = []
  for (const { progress } of progresses) {
    for (const page of progress.pages) {
      pageIds.push(page.submission.id)
      if (page.submission.relatedState === 'pending') pagePending = true
      for (const target of page.capture.relatedTargets as StoredTarget[])
        urls.add(target.url)
    }
  }
  if (pageIds.length)
    for (const member of db
      .select({ id: captures.id, state: captures.state })
      .from(submissions)
      .innerJoin(captures, eq(captures.id, submissions.captureId))
      .where(
        and(
          inJson(submissions.parentSubmission, pageIds),
          like(submissions.idemKey, 'related:%'),
        ),
      )
      .all())
      members.set(member.id, member.state)
  const memberStates = [...members.values()]
  const pending = memberStates.filter(isRunning).length
  const memberProgress: MemberProgress = {
    total: Math.max(members.size, urls.size),
    complete: memberStates.filter((s) => s === 'complete').length,
    partial: memberStates.filter((s) => s === 'partial').length,
    failed: memberStates.filter((s) => s === 'failed').length,
    pending,
    done: !pagePending && pending === 0,
  }
  const running = count(isRunning)
  const done = batch.state !== 'running' && running === 0 && memberProgress.done
  const retryable = done
    ? countFailedMembers(
        db,
        progresses.map((p) => p.progress),
      )
    : 0

  const active: BatchItem[] = []
  for (const root of batchRoots(db, id).toSorted((a, b) => {
    const position = (key: string) => Number(key.split(':').at(-1))
    return position(a.submission.idemKey) - position(b.submission.idemKey)
  })) {
    const item = progresses.find(
      (p) => p.root.submission.id === root.submission.id,
    )
    const rootRunning = isRunning(root.capture.state)
    const membersDone = !item || item.progress.done || item.progress.stopped
    if (!rootRunning && membersDone) continue
    active.push({
      url: root.url,
      collectionId: root.capture.collectionId,
      running: rootRunning,
      ...(item
        ? {
            members: {
              total: item.progress.total,
              complete: item.progress.complete,
              partial: item.progress.partial,
              failed: item.progress.failed,
              pending: item.progress.pending,
              done: item.progress.done,
            },
          }
        : {}),
    })
  }

  return {
    id: batch.id,
    state: batch.state,
    error: batch.error,
    total: batch.collectionIds.length,
    submitted: batch.position,
    reused: batch.reused,
    rejected: batch.rejected,
    running,
    complete: count((s) => s === 'complete'),
    partial: count((s) => s === 'partial'),
    failed: count((s) => s === 'failed'),
    members: memberProgress,
    retryable,
    done,
    active,
  }
}

function countFailedMembers(
  db: Executor,
  progresses: CollectionProgress[],
): number {
  const pages = progresses.flatMap((p) =>
    p.pages
      .filter(
        (page) =>
          page.submission.relatedState === 'complete' &&
          !page.submission.collectionStopped,
      )
      .map((page) => page.submission.id),
  )
  if (!pages.length) return 0
  const failed = db
    .select({ id: captures.id, source: collections.sourceState })
    .from(submissions)
    .innerJoin(captures, eq(captures.id, submissions.captureId))
    .innerJoin(collections, eq(collections.id, captures.collectionId))
    .where(
      and(
        inJson(submissions.parentSubmission, pages),
        like(submissions.idemKey, 'related:%'),
        eq(captures.state, 'failed'),
      ),
    )
    .all()
  return new Set(failed.filter((f) => f.source === null).map((f) => f.id)).size
}

/** Retry the failed members of a finished batch; returns how many. */
export function retryRefreshBatch(ctx: CaptureContext, id: string): number {
  const progress = batchProgress(ctx.db, id)
  if (!progress.done) throw new AppError('batch_running')
  const roots = batchRoots(ctx.db, id)
    .filter((root) => root.capture.isCollection)
    .map((root) => root.submission.id)
  const pages = [...collectionProgresses(ctx.db, roots).values()].flatMap(
    (progress) =>
      progress.pages
        .filter(
          (p) =>
            p.submission.relatedState === 'complete' &&
            !p.submission.collectionStopped,
        )
        .map((p) => p.submission.id),
  )
  return retryFailed(ctx, pages)
}
