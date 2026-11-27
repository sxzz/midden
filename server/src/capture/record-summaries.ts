// Finished capture records, counted once. A record's numbers (an update's
// new, updated, failed, retryable members, its media) are counted over all
// of its members: tens of thousands for a large update, a second or more
// for the 30 a page of the records list shows. Once a record is done they
// no longer move, so the worker writes the counted record down
// (`summary-sweep.ts`) and every read after that, on any thread, takes it
// from `record_summaries` instead of counting.
//
// A summary is used while its `stamp` (of the record's own rows, and of
// whether its target is saved) is the record's now. What else may change a
// finished record's numbers drops its summary:
//   - the web process's acts on it: a retry of what failed, continuing a
//     profile's posts, fetching a page (`dropSummaries`, at the end of each);
//   - what deletes or removes captured content (`dropAllSummaries`);
//   - the rest (a source going private, media settling) in the background:
//     the worker counts a summary again once it is `SUMMARY_MAX_AGE` old.
// A dropped record is counted by the read that finds no summary (and kept
// for a minute by `record-cache.ts`) until the worker has written it again.
import { sql } from 'drizzle-orm'
import { recordSummaries } from '#db/schema.ts'
import { inJson } from '#db/sql.ts'
import type { Executor } from '#db/client.ts'
import type { CaptureRecord } from './records.ts'

/** How long a summary is trusted before the worker counts the record again. */
export const SUMMARY_MAX_AGE = 10 * 60_000

export interface Summary<T extends CaptureRecord = CaptureRecord> {
  stamp: string
  record: T
  computedAt: number
}

/** A record as it was written down: its dates came back as text. */
function revive<T extends CaptureRecord>(json: T): T {
  const stored = json as unknown as { createdAt: string; finishedAt?: string }
  return {
    ...json,
    createdAt: new Date(stored.createdAt),
    finishedAt: stored.finishedAt ? new Date(stored.finishedAt) : null,
  }
}

/** The summaries of these records, by record id. */
export function loadSummaries<T extends CaptureRecord>(
  db: Executor,
  ids: string[],
): Map<string, Summary<T>> {
  if (!ids.length) return new Map()
  return new Map(
    db
      .select()
      .from(recordSummaries)
      .where(inJson(recordSummaries.id, ids))
      .all()
      .map((row) => [
        row.id,
        {
          stamp: row.stamp,
          record: revive(row.summary as T),
          computedAt: row.computedAt.getTime(),
        },
      ]),
  )
}

/** When each of these records was written down, and with which stamp. */
export function summaryStamps(
  db: Executor,
  ids: string[],
): Map<string, { stamp: string; computedAt: number }> {
  if (!ids.length) return new Map()
  return new Map(
    db
      .select({
        id: recordSummaries.id,
        stamp: recordSummaries.stamp,
        computedAt: recordSummaries.computedAt,
      })
      .from(recordSummaries)
      .where(inJson(recordSummaries.id, ids))
      .all()
      .map((row) => [
        row.id,
        { stamp: row.stamp, computedAt: row.computedAt.getTime() },
      ]),
  )
}

/** Write a finished record down. */
export function storeSummary(
  db: Executor,
  id: string,
  stamp: string,
  record: CaptureRecord,
  now = Date.now(),
): void {
  db.insert(recordSummaries)
    .values({ id, stamp, summary: record, computedAt: new Date(now) })
    .onConflictDoUpdate({
      target: recordSummaries.id,
      set: { stamp, summary: record, computedAt: new Date(now) },
    })
    .run()
}

/** The key a record's detail is written down under. */
export const detailKey = (id: string) => `${id}:detail`

/** Drop the summaries of these records (and their details): changed. */
export function dropSummaries(db: Executor, ids: string[]): void {
  if (!ids.length) return
  db.delete(recordSummaries)
    .where(inJson(recordSummaries.id, [...ids, ...ids.map(detailKey)]))
    .run()
}

/** Drop every summary: content records were counted over was removed. */
export function dropAllSummaries(db: Executor): void {
  db.delete(recordSummaries).run()
}

/** Drop the summaries of records that are gone. */
export function dropOrphanSummaries(db: Executor): number {
  return Number(
    db.run(sql`
    DELETE FROM record_summaries
    WHERE replace(id, ':detail', '') NOT IN (SELECT id FROM updates)
      AND replace(id, ':detail', '') NOT IN (SELECT id FROM submissions)`)
      .changes,
  )
}
