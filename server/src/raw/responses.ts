import { Buffer } from 'node:buffer'
import { asc, eq, sql } from 'drizzle-orm'
import { rawGarbage, sourceResponses } from '#db/schema.ts'
import type { Database, Executor, Transaction } from '#db/client.ts'
import type { RawStore } from './store.ts'

// A stored body is cleared to this: the column is NOT NULL.
const EMPTY = Buffer.alloc(0)

export type SourceResponse = typeof sourceResponses.$inferSelect

/**
 * Delete the raw responses of these captures. The keys of those stored in
 * the bucket become garbage: maintenance deletes each object once no row
 * uses it (see `collectRawGarbage`).
 */
export function deleteSourceResponses(
  tx: Transaction,
  captureIds: readonly string[],
  now: Date,
): void {
  if (!captureIds.length) return
  const ids = JSON.stringify(captureIds)
  tx.run(sql`
    INSERT INTO ${rawGarbage} (key, since)
    SELECT DISTINCT ${sourceResponses.sha256}, ${now.getTime()}
    FROM ${sourceResponses}
    WHERE ${sourceResponses.captureId} IN (SELECT value FROM json_each(${ids}))
      AND ${sourceResponses.remoteAt} IS NOT NULL
    ON CONFLICT (key) DO NOTHING`)
  tx.run(sql`
    DELETE FROM ${sourceResponses}
    WHERE ${sourceResponses.captureId} IN (SELECT value FROM json_each(${ids}))`)
}

/**
 * Record bodies confirmed in the bucket and clear them here, in one
 * transaction. Each row also moves to the end of the table (a new rowid):
 * cleared in place, a row would keep the page its body began on, mostly
 * empty; moved, it joins the other small rows at the end, and the pages it
 * left empty go to the freelist, which `incremental_vacuum` returns. A row
 * deleted meanwhile leaves its object to garbage collection, which deletes
 * it unless another row uses it. Returns the rows recorded.
 */
export function markStored(
  db: Database,
  rows: readonly Pick<SourceResponse, 'id' | 'sha256'>[],
  now: Date,
): number {
  if (!rows.length) return 0
  return db.transaction((tx) => {
    let marked = 0
    for (const row of rows) {
      const { changes } = tx.run(sql`
        UPDATE ${sourceResponses}
        SET body = ${EMPTY}, remote_at = ${now.getTime()},
          rowid = (SELECT max(rowid) + 1 FROM ${sourceResponses})
        WHERE ${sourceResponses.id} = ${row.id}
          AND ${sourceResponses.sha256} = ${row.sha256}
          AND ${sourceResponses.remoteAt} IS NULL`)
      if (changes) {
        marked++
        continue
      }
      const gone = !tx
        .select({ id: sourceResponses.id })
        .from(sourceResponses)
        .where(eq(sourceResponses.id, row.id))
        .get()
      if (gone)
        tx.insert(rawGarbage)
          .values({ key: row.sha256, since: now })
          .onConflictDoNothing()
          .run()
    }
    return marked
  })
}

/** The raw responses of a capture, in order, bodies left where they are. */
export function captureResponses(
  db: Executor,
  captureId: string,
): SourceResponse[] {
  return db
    .select()
    .from(sourceResponses)
    .where(eq(sourceResponses.captureId, captureId))
    .orderBy(asc(sourceResponses.position))
    .all()
}

/** A raw response's body, from the database or the raw bucket. */
export function sourceBody(
  raw: RawStore | undefined,
  row: Pick<SourceResponse, 'body' | 'sha256' | 'remoteAt'>,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (!row.remoteAt) return Promise.resolve(row.body)
  if (!raw)
    return Promise.reject(
      new Error(
        `raw response ${row.sha256} is in the raw bucket, but RAW_R2_BUCKET and its keys are not set`,
      ),
    )
  return raw.get(row.sha256, signal)
}
