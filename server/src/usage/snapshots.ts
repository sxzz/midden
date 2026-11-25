import { asc, gte, sql } from 'drizzle-orm'
import { storageSnapshots, type BucketDay } from '#db/schema.ts'
import type { Database } from '#db/client.ts'
import type { R2Day } from './cost.ts'
import type { LocalUsage } from './local.ts'

export const isoDay = (at: number) => new Date(at).toISOString().slice(0, 10)

/** One day of the history, as the page charts it. */
export interface SnapshotDay {
  day: string
  r2: Record<string, BucketDay> | null
  db_bytes: number | null
  thumbnail_bytes: number | null
  free_bytes: number | null
}

/**
 * Today's local figures: the latest reading of the day replaces the one
 * before it.
 */
export function recordLocal(db: Database, usage: LocalUsage, now: number) {
  const values = {
    dbBytes: usage.database.bytes,
    thumbnailBytes: usage.thumbnails.bytes,
    freeBytes: usage.disk.free_bytes,
    updatedAt: new Date(now),
  }
  db.insert(storageSnapshots)
    .values({ day: isoDay(now), ...values })
    .onConflictDoUpdate({ target: storageSnapshots.day, set: values })
    .run()
}

/**
 * R2 figures for each day the analytics covered. A past day's figures are
 * final once its day has ended, and today's grow until then; either way the
 * newest reading replaces the stored one. Days the analytics no longer
 * cover keep what was stored, which is how the history outlives the
 * dataset's retention.
 */
export function recordR2(
  db: Database,
  days: ReadonlyMap<string, Record<string, BucketDay>>,
  now: number,
) {
  if (!days.size) return
  db.transaction((tx) => {
    for (const [day, r2] of days)
      tx.insert(storageSnapshots)
        .values({ day, r2, updatedAt: new Date(now) })
        .onConflictDoUpdate({
          target: storageSnapshots.day,
          set: { r2, updatedAt: new Date(now) },
        })
        .run()
  })
}

/** The history from `since` (a day, inclusive), oldest first. */
export function snapshots(db: Database, since?: string): SnapshotDay[] {
  return db
    .select({
      day: storageSnapshots.day,
      r2: storageSnapshots.r2,
      db_bytes: storageSnapshots.dbBytes,
      thumbnail_bytes: storageSnapshots.thumbnailBytes,
      free_bytes: storageSnapshots.freeBytes,
    })
    .from(storageSnapshots)
    .where(since ? gte(storageSnapshots.day, since) : sql`1`)
    .orderBy(asc(storageSnapshots.day))
    .all()
}

/** Each day's R2 figures summed over the buckets, for the bill. */
export function r2Days(days: readonly SnapshotDay[]): R2Day[] {
  return days.flatMap(({ day, r2 }) => {
    if (!r2) return []
    const buckets = Object.values(r2)
    return [
      {
        day,
        bytes: buckets.reduce((sum, b) => sum + (b.bytes ?? 0), 0),
        classA: buckets.reduce((sum, b) => sum + b.class_a, 0),
        classB: buckets.reduce((sum, b) => sum + b.class_b, 0),
      },
    ]
  })
}
