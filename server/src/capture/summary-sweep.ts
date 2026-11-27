// The worker writes down the capture records that have finished
// (`record-summaries.ts`): in a sweep every few seconds it counts each
// finished record that has no summary, whose summary no longer matches the
// record's own rows, or that is older than `SUMMARY_MAX_AGE`, newest first,
// until a time budget is spent. Counting and writing happen in one write
// transaction, so nothing the web process writes lands in between.
//
// A record that is not done is left alone (the read counts it live, and the
// read thread keeps it for a few seconds); it is looked at again after
// `NOT_DONE_WAIT`. The same sweep is the backfill: a deployment that adds
// summaries has them written within a few sweeps, newest first.
import { performance } from 'node:perf_hooks'
import { desc, eq, ne } from 'drizzle-orm'
import { submissions, updates } from '#db/schema.ts'
import {
  detailKey,
  dropOrphanSummaries,
  dropSummaries,
  storeSummary,
  SUMMARY_MAX_AGE,
  summaryStamps,
} from './record-summaries.ts'
import {
  countRecordDetail,
  recordRows,
  rowStamp,
  toRecords,
} from './records.ts'
import {
  countUpdateDetail,
  countUpdates,
  loadUpdate,
  savedTargets,
  updateStamp,
} from './updates.ts'
import type { CaptureContext } from './context.ts'

/** How long a sweep may count. */
export const SWEEP_BUDGET = 2000
/** How many of the newest updates and requests a sweep looks at. */
const SCAN = 2000
const REQUEST_SCAN = 200
/** How long before a record found not done is counted again. */
export const NOT_DONE_WAIT = 30_000

const looked = new WeakMap<CaptureContext, Map<string, number>>()

/** One sweep; returns how many records it wrote down. */
export function refreshSummaries(
  ctx: CaptureContext,
  options: { budgetMs?: number } = {},
): number {
  const { db } = ctx
  const now = ctx.now?.() ?? Date.now()
  const deadline = performance.now() + (options.budgetMs ?? SWEEP_BUDGET)
  const notDone = looked.get(ctx) ?? new Map<string, number>()
  looked.set(ctx, notDone)
  const due = (id: string, stored: { computedAt: number } | undefined) =>
    !(notDone.get(id)! > now - NOT_DONE_WAIT) &&
    (!stored || now - stored.computedAt > SUMMARY_MAX_AGE)
  let written = 0

  // Updates, by the columns their stamp reads.
  const rows = db
    .select({
      id: updates.id,
      target: updates.target,
      targetId: updates.targetId,
      state: updates.state,
      position: updates.position,
      skipped: updates.skipped,
      error: updates.error,
      pausedAt: updates.pausedAt,
    })
    .from(updates)
    .where(ne(updates.state, 'running'))
    .orderBy(desc(updates.createdAt), desc(updates.id))
    .limit(SCAN)
    .all()
  const saved = savedTargets(db, rows)
  const stored = summaryStamps(
    db,
    rows.map((row) => row.id),
  )
  for (const row of rows) {
    if (performance.now() > deadline) return written
    const found = stored.get(row.id)
    const stamp = updateStamp(row, saved.has(row.id))
    if (
      found?.stamp === stamp
        ? !due(row.id, found)
        : notDone.get(row.id)! > now - NOT_DONE_WAIT
    )
      continue
    written += db.transaction((tx) => {
      const update = loadUpdate(tx, row.id)
      const fresh = savedTargets(tx, [update])
      const [record] = countUpdates(tx, [update])
      if (!record!.done) {
        notDone.set(row.id, now)
        dropSummaries(tx, [row.id])
        return 0
      }
      notDone.delete(row.id)
      const stamp = updateStamp(update, fresh.has(row.id))
      storeSummary(tx, row.id, stamp, record!, now)
      storeSummary(
        tx,
        detailKey(row.id),
        stamp,
        countUpdateDetail(tx, update, fresh.has(row.id), record),
        now,
      )
      return 1
    })
  }

  // The newest requests' records.
  const requests = recordRows(db, undefined, REQUEST_SCAN)
  const requestStored = summaryStamps(
    db,
    requests.map((row) => row.submission.id),
  )
  for (const row of requests) {
    if (performance.now() > deadline) return written
    const id = row.submission.id
    const found = requestStored.get(id)
    if (
      found?.stamp === rowStamp(row)
        ? !due(id, found)
        : notDone.get(id)! > now - NOT_DONE_WAIT
    )
      continue
    written += db.transaction((tx) => {
      const [fresh] = recordRows(tx, eq(submissions.id, id), 1)
      if (!fresh) return 0
      const [record] = toRecords(tx, [fresh])
      if (!record!.done) {
        notDone.set(id, now)
        dropSummaries(tx, [id])
        return 0
      }
      notDone.delete(id)
      storeSummary(tx, id, rowStamp(fresh), record!, now)
      storeSummary(
        tx,
        detailKey(id),
        rowStamp(fresh),
        countRecordDetail(tx, fresh, record),
        now,
      )
      return 1
    })
  }
  dropOrphanSummaries(db)
  return written
}
