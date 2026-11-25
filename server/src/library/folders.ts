import { asc, eq } from 'drizzle-orm'
import { newId } from '#db/id.ts'
import { folders } from '#db/schema.ts'
import { AppError } from '#errors.ts'
import { pruneTags } from './annotations.ts'
import { countsCached, filterCounts } from './counts.ts'
import { parseFilterQuery } from './filter-query.ts'
import { checkFilter } from './list.ts'
import { revokeOrphanedShares } from './shares.ts'
import type { Database, Executor } from '#db/client.ts'

/** A saved library filter (收藏夹) and how many saved items it selects. */
export interface Folder {
  id: string
  name: string
  /** The list's query string, without a page cursor. */
  filter: string
  count: number
  /** The count by the root's entity type, without the empty ones. */
  types: Record<string, number>
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

function view(db: Database, row: Row): Folder {
  const { count, types } = filterCounts(db, row.filter)
  return {
    id: row.id,
    name: row.name,
    filter: row.filter,
    count,
    types,
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
    if (!countsCached(db, row.filter))
      await new Promise((resolve) => setImmediate(resolve))
    result.push(view(db, row))
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
  return view(db, row)
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
  return view(db, row)
}

export function deleteFolder(db: Database, id: string): void {
  db.transaction((tx) => {
    const row = tx.delete(folders).where(eq(folders.id, id)).returning().get()
    if (!row) throw new AppError('not_found')
    pruneTags(tx)
    revokeOrphanedShares(tx)
  })
}
