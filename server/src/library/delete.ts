import { and, eq, inArray, lte, sql } from 'drizzle-orm'
import { recordFilterSQL } from '#capture/records.ts'
import { markUnreferenced } from '#capture/submit.ts'
import { library, submissions } from '#db/schema.ts'
import { AppError } from '#errors.ts'
import { pruneTags } from './annotations.ts'
import type { Database } from '#db/client.ts'

/**
 * Remove a collection from the library. Its content is collected by
 * maintenance once no capture of it is running.
 */
export function deleteCollection(db: Database, collectionId: string): void {
  db.transaction((tx) => {
    const removed = tx
      .delete(library)
      .where(eq(library.collectionId, collectionId))
      .run()
    if (removed.changes === 0) throw new AppError('not_found')
    pruneTags(tx)
    markUnreferenced(tx, collectionId, new Date())
  })
}

/**
 * Empty the library and the capture records up to `before`. Requests in
 * flight stop expanding: their submissions are gone.
 */
export function deleteAll(
  db: Database,
  before = new Date(),
): { collections: number; records: number } {
  return db.transaction((tx) => {
    const saved = tx
      .select({ id: library.collectionId })
      .from(library)
      .where(lte(library.createdAt, before))
      .all()
      .map((row) => row.id)
    const records =
      tx
        .select({ n: sql<number>`count(*)`.mapWith(Number) })
        .from(submissions)
        .where(and(recordFilterSQL(), lte(submissions.createdAt, before)))
        .get()?.n ?? 0
    if (saved.length)
      tx.delete(library).where(inArray(library.collectionId, saved)).run()
    pruneTags(tx)
    for (const id of saved) markUnreferenced(tx, id, before)
    tx.delete(submissions).where(lte(submissions.createdAt, before)).run()
    return { collections: saved.length, records }
  })
}
