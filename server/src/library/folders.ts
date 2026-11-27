import { asc, eq } from 'drizzle-orm'
import { newId } from '#db/id.ts'
import { folders } from '#db/schema.ts'
import { AppError } from '#errors.ts'
import { pruneTags } from './annotations.ts'
import { parseFilterQuery } from './filter-query.ts'
import { storedCounts, type StoredCounts } from './folder-counts.ts'
import { checkFilter } from './list.ts'
import { revokeOrphanedShares } from './shares.ts'
import type { Database, Executor } from '#db/client.ts'

/**
 * A saved library filter (收藏夹) and how many saved items it selects, as
 * last counted (`folder-counts.ts`): null before the first count.
 */
export interface Folder {
  id: string
  name: string
  /** The list's query string, without a page cursor. */
  filter: string
  count: number | null
  /** The count by the root's entity type, without the empty ones. */
  types: Record<string, number> | null
  /** When it was counted. */
  counted_at: string | null
  /** The library or the filter changed since: a new count is coming. */
  stale: boolean
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

/**
 * A folder holds posts and accounts alike, and its list shows each kind in a
 * tab of its own, so its entity types only name platforms: whichever kind a
 * type names, the folder keeps both kinds of that platform.
 */
function platformsOnly(raw: string): string {
  const params = new URLSearchParams(raw)
  const types = params.get('entity_type')
  if (!types) return raw
  const platforms = new Set(
    types.split(',').map((type) => type.split('.', 1)[0]),
  )
  platforms.delete('')
  params.set(
    'entity_type',
    [...platforms]
      .toSorted()
      .flatMap((p) => [`${p}.post`, `${p}.profile`])
      .join(','),
  )
  return params.toString()
}

/** The canonical query string, if the list accepts the filter. */
function canonicalFilter(raw: string): string {
  if (raw.length > MAX_FILTER) throw new AppError('invalid_filter')
  const { filter, canonical } = parseFilterQuery(platformsOnly(raw))
  checkFilter(filter)
  return canonical
}

type Row = typeof folders.$inferSelect

function view(row: Row, stored: StoredCounts | undefined): Folder {
  return {
    id: row.id,
    name: row.name,
    filter: row.filter,
    count: stored?.counts.count ?? null,
    types: stored?.counts.types ?? null,
    counted_at: stored?.countedAt.toISOString() ?? null,
    stale: stored?.stale ?? true,
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
 * Every folder in the order they were made, with their counts as last
 * counted. Nothing is counted here.
 */
export function listFolders(db: Executor): Folder[] {
  const rows = db
    .select()
    .from(folders)
    .orderBy(asc(folders.createdAt), asc(folders.id))
    .all()
  const stored = storedCounts(db, rows)
  return rows.map((row) => view(row, stored.get(row.id)))
}

/** One folder as `listFolders` lists it. */
export function folderView(db: Executor, id: string): Folder {
  const row = db.select().from(folders).where(eq(folders.id, id)).get()
  if (!row) throw new AppError('not_found')
  return view(row, storedCounts(db, [row]).get(row.id))
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
  return view(row, undefined)
}

/**
 * Rename a folder and/or replace its filter. Its stored counts stand until
 * it is counted again, stale when the filter changed.
 */
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
  return view(row, storedCounts(db, [row]).get(row.id))
}

export function deleteFolder(db: Database, id: string): void {
  db.transaction((tx) => {
    const row = tx.delete(folders).where(eq(folders.id, id)).returning().get()
    if (!row) throw new AppError('not_found')
    pruneTags(tx)
    revokeOrphanedShares(tx)
  })
}
