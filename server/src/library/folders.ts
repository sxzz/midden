import { asc, eq } from 'drizzle-orm'
import { newId } from '#db/id.ts'
import { folders } from '#db/schema.ts'
import { AppError } from '#errors.ts'
import { pruneTags } from './annotations.ts'
import { parseFilterQuery } from './filter-query.ts'
import { checkFilter, countCollections } from './list.ts'
import type { Database, Executor } from '#db/client.ts'

/** A saved library filter (收藏夹) and how many saved items it selects. */
export interface Folder {
  id: string
  name: string
  /** The list's query string, without a page cursor. */
  filter: string
  count: number
  created_at: string
  updated_at: string
}

export interface FolderUpdate {
  name?: string
  filter?: string
}

const MAX_NAME = 64
const MAX_FILTER = 16_384

const runes = (value: string) => [...value].length

function checkName(raw: string): string {
  const name = raw.trim()
  if (!name || runes(name) > MAX_NAME || name.includes('\0'))
    throw new AppError('invalid_folder')
  return name
}

/** The canonical query string, if the list accepts the filter. */
function canonicalFilter(raw: string): string {
  if (raw.length > MAX_FILTER) throw new AppError('invalid_filter')
  const { filter, canonical } = parseFilterQuery(raw)
  checkFilter(filter)
  return canonical
}

interface Counts {
  stamp: string
  byFilter: Map<string, number>
}

/**
 * Counts by filter, kept while nothing writes to the database. One count
 * reads the whole library (tens of milliseconds at 60k items), so a few
 * dozen folders are counted once per change rather than on every request.
 * `total_changes()` moves with this connection's writes, `data_version`
 * with another process's (the CLI).
 */
const counts = new WeakMap<object, Counts>()

function cachedCounts(db: Database): Counts {
  const { stamp } = db.$client
    .prepare(
      `SELECT total_changes() || ':' || data_version AS stamp FROM pragma_data_version`,
    )
    .get() as { stamp: string }
  let cache = counts.get(db.$client)
  if (cache?.stamp !== stamp) {
    cache = { stamp, byFilter: new Map() }
    counts.set(db.$client, cache)
  }
  return cache
}

/** The order does not change what a filter selects. */
function countKey(filter: string): string {
  const params = new URLSearchParams(filter)
  params.delete('sort')
  params.delete('order')
  return params.toString()
}

function countFolder(db: Database, filter: string): number {
  const cache = cachedCounts(db)
  const key = countKey(filter)
  let count = cache.byFilter.get(key)
  if (count === undefined) {
    count = countCollections(db, parseFilterQuery(key).filter)
    cache.byFilter.set(key, count)
  }
  return count
}

type Row = typeof folders.$inferSelect

function view(row: Row, count: number): Folder {
  return {
    id: row.id,
    name: row.name,
    filter: row.filter,
    count,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  }
}

function sameName(db: Executor, name: string, except?: string): boolean {
  const found = db
    .select({ id: folders.id })
    .from(folders)
    .where(eq(folders.name, name))
    .get()
  return !!found && found.id !== except
}

const duplicate = () => new AppError('conflict', '已有同名的收藏夹')

/**
 * Every folder in the order they were made, with their counts. Counting is
 * synchronous, so other requests get a turn between folders not yet counted.
 */
export async function listFolders(db: Database): Promise<Folder[]> {
  const rows = db
    .select()
    .from(folders)
    .orderBy(asc(folders.createdAt), asc(folders.id))
    .all()
  const result: Folder[] = []
  for (const row of rows) {
    if (!cachedCounts(db).byFilter.has(countKey(row.filter)))
      await new Promise((resolve) => setImmediate(resolve))
    result.push(view(row, countFolder(db, row.filter)))
  }
  return result
}

export function createFolder(
  db: Database,
  input: { name: string; filter: string },
): Folder {
  const name = checkName(input.name)
  const filter = canonicalFilter(input.filter)
  const row = db.transaction((tx) => {
    if (sameName(tx, name)) throw duplicate()
    const now = new Date()
    return tx
      .insert(folders)
      .values({ id: newId(), name, filter, createdAt: now, updatedAt: now })
      .returning()
      .get()
  })
  return view(row, countFolder(db, row.filter))
}

/** Rename a folder and/or replace its filter. */
export function updateFolder(
  db: Database,
  id: string,
  update: FolderUpdate,
): Folder {
  const name = update.name === undefined ? undefined : checkName(update.name)
  const filter =
    update.filter === undefined ? undefined : canonicalFilter(update.filter)
  const row = db.transaction((tx) => {
    if (name !== undefined && sameName(tx, name, id)) throw duplicate()
    const updated = tx
      .update(folders)
      .set({ name, filter, updatedAt: new Date() })
      .where(eq(folders.id, id))
      .returning()
      .get()
    if (!updated) throw new AppError('not_found')
    // A tag kept only for the old filter can go now.
    if (filter !== undefined) pruneTags(tx)
    return updated
  })
  return view(row, countFolder(db, row.filter))
}

export function deleteFolder(db: Database, id: string): void {
  db.transaction((tx) => {
    const row = tx.delete(folders).where(eq(folders.id, id)).returning().get()
    if (!row) throw new AppError('not_found')
    pruneTags(tx)
  })
}
