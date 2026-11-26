import { and, asc, eq, not, sql } from 'drizzle-orm'
import {
  rawGarbage,
  rawUploadFailures,
  sourceResponseBodies,
  sourceResponses,
} from '#db/schema.ts'
import type { Database, Executor, Transaction } from '#db/client.ts'
import type { RawStore } from './store.ts'
import type { Buffer } from 'node:buffer'

export type SourceResponse = typeof sourceResponses.$inferSelect

/** A row whose body is still in the database. */
export const isLocal = sql`EXISTS (SELECT 1 FROM ${sourceResponseBodies} WHERE ${sourceResponseBodies.responseId} = ${sourceResponses.id})`

/**
 * Delete the raw responses of these captures, with their bodies. The keys
 * of those stored in the bucket become garbage: maintenance deletes each
 * object once no row uses it (see `collectRawGarbage`).
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
      AND NOT ${isLocal}
    ON CONFLICT (key) DO NOTHING`)
  tx.run(sql`
    DELETE FROM ${sourceResponses}
    WHERE ${sourceResponses.captureId} IN (SELECT value FROM json_each(${ids}))`)
}

/**
 * Record a body confirmed in the bucket: its body row goes, the metadata
 * row stays as it is. A row deleted meanwhile leaves its object to garbage
 * collection, which deletes it unless another row uses it. Whether the row
 * was recorded.
 */
function markRow(
  tx: Transaction,
  row: Pick<SourceResponse, 'id' | 'sha256'>,
  now: Date,
): boolean {
  const { changes } = tx.run(sql`
    DELETE FROM ${sourceResponseBodies}
    WHERE ${sourceResponseBodies.responseId} = ${row.id}
      AND EXISTS (SELECT 1 FROM ${sourceResponses}
        WHERE ${sourceResponses.id} = ${row.id}
          AND ${sourceResponses.sha256} = ${row.sha256})`)
  if (changes) {
    tx.delete(rawUploadFailures)
      .where(eq(rawUploadFailures.responseId, row.id))
      .run()
    return true
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
  return false
}

/**
 * A row whose bytes did not match its hash: it is never stored, so its
 * bytes stay as they are, and nothing retries it.
 */
export const notCorrupt = sql`NOT EXISTS (SELECT 1 FROM ${rawUploadFailures} WHERE ${rawUploadFailures.responseId} = ${sourceResponses.id} AND ${rawUploadFailures.retryAt} IS NULL)`

/** Rows that still hold this body here, but for ones found corrupt. */
export function localRows(
  db: Executor,
  sha256: string,
): Pick<SourceResponse, 'id' | 'sha256'>[] {
  return db
    .select({ id: sourceResponses.id, sha256: sourceResponses.sha256 })
    .from(sourceResponses)
    .where(and(eq(sourceResponses.sha256, sha256), isLocal, notCorrupt))
    .all()
}

/** Whether a row recorded this body in the bucket already. */
export function storedBefore(db: Executor, sha256: string): boolean {
  return !!db
    .select({ id: sourceResponses.id })
    .from(sourceResponses)
    .where(and(eq(sourceResponses.sha256, sha256), not(isLocal)))
    .get()
}

/** Record these rows' bodies as in the bucket, in one transaction. */
export function markStored(
  db: Database,
  rows: readonly Pick<SourceResponse, 'id' | 'sha256'>[],
  now: Date,
): number {
  if (!rows.length) return 0
  return db.transaction(
    (tx) => rows.filter((row) => markRow(tx, row, now)).length,
  )
}

/** A raw response as listed: where its body is kept. */
export type ListedResponse = SourceResponse & { local: boolean }

/** The raw responses of a capture, in order, without their bodies. */
export function captureResponses(
  db: Executor,
  captureId: string,
): ListedResponse[] {
  return db
    .select({
      id: sourceResponses.id,
      captureId: sourceResponses.captureId,
      position: sourceResponses.position,
      contentType: sourceResponses.contentType,
      sourceUrl: sourceResponses.sourceUrl,
      sha256: sourceResponses.sha256,
      size: sourceResponses.size,
      createdAt: sourceResponses.createdAt,
      local: sql<boolean>`(${isLocal})`.mapWith(Boolean),
    })
    .from(sourceResponses)
    .where(eq(sourceResponses.captureId, captureId))
    .orderBy(asc(sourceResponses.position))
    .all()
}

/** A raw response's body, from the database or the raw bucket. */
export function sourceBody(
  db: Executor,
  raw: RawStore | undefined,
  row: Pick<SourceResponse, 'id' | 'sha256'>,
  signal?: AbortSignal,
): Promise<Buffer> {
  const local = db
    .select({ body: sourceResponseBodies.body })
    .from(sourceResponseBodies)
    .where(eq(sourceResponseBodies.responseId, row.id))
    .get()
  if (local) return Promise.resolve(local.body)
  if (!raw)
    return Promise.reject(
      new Error(
        `raw response ${row.sha256} is in the raw bucket, but RAW_R2_BUCKET is not set`,
      ),
    )
  return raw.get(row.sha256, signal)
}
