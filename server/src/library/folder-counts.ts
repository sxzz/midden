// Folder counts are counted in the background and read from `folder_counts`.
// One count reads the whole library, so `/v1/folders` (polled by the web app,
// listed in its sidebar) never counts: it answers what was stored, and says
// when that is out of date (`stale`).
//
// The worker (`FolderCountSweep`) looks every few seconds. A folder never
// counted, whose query (or a folder it names) changed, or whose relative
// dates reached a new day is counted at once (`folderKey`). Folders counted at an older `library_version` (the
// library changed since) are counted again at most every `DEBOUNCE`, or
// `BUSY_DEBOUNCE` while the worker runs jobs: during an update the version
// moves with nearly every saved post. Creating or editing a folder counts it
// once on a read thread (`countFolder`) and stores that.
import { eq, sql } from 'drizzle-orm'
import { folderCounts, folders } from '#db/schema.ts'
import { selectionCounts, selectionCountsOf } from './counts.ts'
import {
  catalogTypes,
  folderKey,
  folderSelection,
  type FolderQuery,
} from './folder-query.ts'
import type { Database, Executor } from '#db/client.ts'
import type { Types } from '#query/compile.ts'
import type { FilterCounts } from './list.ts'

/** Between recounts of folders the library changed under. */
export const DEBOUNCE = 15_000
export const BUSY_DEBOUNCE = 30_000

/** A folder's counts, as stored or just counted. */
export interface CountedFolder {
  folderId: string
  /** What was counted: the query, its relative dates resolved. */
  key: string
  /** `library_version` when counting started. */
  version: number
  counts: FilterCounts
  countedAt: number
}

/** The stored counts of a folder, and whether they are out of date. */
export interface StoredCounts {
  counts: FilterCounts
  countedAt: Date
  stale: boolean
}

export function libraryVersion(db: Executor): number {
  const row = db.get<{ n: number }>(
    sql`SELECT n FROM library_version WHERE id = 1`,
  ) as { n: number } | undefined
  return row?.n ?? 0
}

/** Stored counts by folder id, each with whether it is out of date. */
export function storedCounts(
  db: Executor,
  rows: ({ id: string } & FolderQuery)[],
): Map<string, StoredCounts> {
  const version = libraryVersion(db)
  const stored = new Map(
    db
      .select()
      .from(folderCounts)
      .all()
      .map((row) => [row.folderId, row]),
  )
  const out = new Map<string, StoredCounts>()
  for (const folder of rows) {
    const row = stored.get(folder.id)
    if (!row) continue
    out.set(folder.id, {
      counts: { count: row.count, types: row.types },
      countedAt: row.countedAt,
      stale: row.version !== version || row.key !== folderKey(db, folder),
    })
  }
  return out
}

/** Count one folder now; on a read thread when the web process asks. */
export function countFolder(
  db: Database,
  folderId: string,
  now = Date.now(),
  types: Types = catalogTypes(db),
): CountedFolder | undefined {
  const version = libraryVersion(db)
  const row = db.select().from(folders).where(eq(folders.id, folderId)).get()
  if (!row) return
  return {
    folderId,
    key: folderKey(db, row, now),
    version,
    counts: selectionCounts(db, folderSelection(db, types, row, now)),
    countedAt: now,
  }
}

/**
 * Store counts, unless the folder was deleted, or a newer count of the same
 * key is already there.
 */
export function storeFolderCounts(
  db: Executor,
  counted: readonly CountedFolder[],
): void {
  for (const c of counted)
    db.run(sql`
      INSERT INTO folder_counts (folder_id, key, version, count, types, counted_at)
      SELECT ${c.folderId}, ${c.key}, ${c.version}, ${c.counts.count},
        ${JSON.stringify(c.counts.types)}, ${c.countedAt}
      WHERE EXISTS (SELECT 1 FROM folders WHERE id = ${c.folderId})
      ON CONFLICT (folder_id) DO UPDATE SET key = excluded.key,
        version = excluded.version, count = excluded.count,
        types = excluded.types, counted_at = excluded.counted_at
      WHERE excluded.key <> folder_counts.key
        OR excluded.version >= folder_counts.version`)
}

/**
 * The worker's side: counts what is out of date, in passes (`filterCountsOf`
 * counts up to eight folders in one read of the library and yields between
 * passes), and stores it in one short write.
 */
export class FolderCountSweep {
  readonly #db: Database
  readonly #types: Types
  readonly #now: () => number
  #recounted = -Infinity

  constructor(
    db: Database,
    options: { now?: () => number; types?: Types } = {},
  ) {
    this.#db = db
    this.#types = options.types ?? catalogTypes(db)
    this.#now = options.now ?? Date.now
  }

  /** One look; returns how many folders it counted. */
  async run(options: { busy?: boolean } = {}): Promise<number> {
    const db = this.#db
    const now = this.#now()
    const version = libraryVersion(db)
    const rows = db.select().from(folders).all()
    const stored = new Map(
      db
        .select({
          id: folderCounts.folderId,
          key: folderCounts.key,
          version: folderCounts.version,
        })
        .from(folderCounts)
        .all()
        .map((row) => [row.id, row]),
    )
    const keys = new Map(rows.map((row) => [row.id, folderKey(db, row, now)]))
    const fresh = rows.filter(
      (row) => stored.get(row.id)?.key !== keys.get(row.id),
    )
    const stale = rows.filter((row) => {
      const found = stored.get(row.id)
      return (
        !!found && found.key === keys.get(row.id) && found.version !== version
      )
    })
    const wait = options.busy ? BUSY_DEBOUNCE : DEBOUNCE
    const due = stale.length > 0 && now - this.#recounted >= wait
    if (due) this.#recounted = now
    const todo = [...fresh, ...(due ? stale : [])]
    if (!todo.length) return 0
    // A folder whose query no longer runs (it names what is gone) keeps
    // its last count, out of date.
    const runs = todo.flatMap((row) => {
      try {
        return [{ row, selection: folderSelection(db, this.#types, row, now) }]
      } catch {
        return []
      }
    })
    const counts = await selectionCountsOf(
      db,
      runs.map((r) => r.selection),
    )
    db.transaction((tx) =>
      storeFolderCounts(
        tx,
        runs.map(({ row }, i) => ({
          folderId: row.id,
          key: keys.get(row.id)!,
          version,
          counts: counts[i]!,
          countedAt: now,
        })),
      ),
    )
    return todo.length
  }
}

/**
 * Count a folder a write just made or changed, store it and log a failure:
 * `count` runs on a read thread in the web process; without one, here. The
 * worker counts it anyway if this fails.
 */
export async function countWrittenFolder(
  db: Database,
  folderId: string,
  count: ((id: string) => Promise<CountedFolder | null>) | undefined,
  logger?: { warn: (fields: object, message: string) => void },
  types?: Types,
): Promise<void> {
  try {
    const counted = count
      ? await count(folderId)
      : (countFolder(db, folderId, undefined, types) ?? null)
    if (counted) storeFolderCounts(db, [counted])
  } catch (error) {
    logger?.warn({ err: error, folderId }, 'folder not counted')
  }
}
