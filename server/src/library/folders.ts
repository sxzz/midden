import { asc, eq } from 'drizzle-orm'
import { newId } from '#db/id.ts'
import { folders } from '#db/schema.ts'
import { AppError } from '#errors.ts'
import { OWNER_LIMITS, parseQuery } from '#query/ast.ts'
import { filterToQuery } from '#query/convert.ts'
import { pruneTags } from './annotations.ts'
import { parseFilterQuery } from './filter-query.ts'
import { storedCounts, type StoredCounts } from './folder-counts.ts'
import {
  catalogTypes,
  displayQuery,
  folderFilter,
  rewriteFolderQueries,
  storedQuery,
} from './folder-query.ts'
import { checkFilter, zoneOf } from './list.ts'
import { revokeOrphanedShares } from './shares.ts'
import type { Database, Executor } from '#db/client.ts'
import type { Types } from '#query/compile.ts'

/**
 * A saved query (收藏夹) and how many saved items it selects, as last
 * counted (`folder-counts.ts`): null before the first count.
 */
export interface Folder {
  id: string
  name: string
  /** Its query, tags and folders by name. */
  query: string
  /**
   * The list's query string when the list's filter alone says what the
   * query does (what the web's filter controls can show); null otherwise.
   */
  filter: string | null
  sort: string
  order: string
  tz: string
  count: number | null
  /** The count by the root's entity type, without the empty ones. */
  types: Record<string, number> | null
  /** When it was counted. */
  counted_at: string | null
  /** The library or the query changed since: a new count is coming. */
  stale: boolean
  created_at: string
  updated_at: string
}

/**
 * What a folder is made of: a query (tags and folders by name or id), or a
 * list filter, which is written as the query that says the same; with its
 * order and the zone of its relative dates.
 */
export interface FolderInput {
  name?: string
  query?: string
  filter?: string
  sort?: string
  order?: string
  tz?: string
}

const MAX_NAME = 64
const MAX_QUERY = 16_384
const SORTS = new Set([
  'relevance',
  'saved',
  'updated',
  'published',
  'storage',
  'followers',
  'following',
])

const runes = (value: string) => [...value].length

function checkName(raw: string): string {
  const name = raw.trim()
  if (!name || runes(name) > MAX_NAME || name.includes('\0'))
    throw new AppError('invalid_folder')
  return name
}

/**
 * A folder holds posts and accounts alike, and its list shows each kind in a
 * tab of its own, so a filter's entity types only name platforms: whichever
 * kind a type names, the folder keeps both kinds of that platform.
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

/** What a folder keeps of its input; absent parts stay as they are. */
function stored(
  db: Executor,
  types: Types,
  input: FolderInput,
  self?: string,
): Partial<{ query: string; sort: string; order: string; tz: string }> {
  if (input.filter !== undefined) {
    if (input.filter.length > MAX_QUERY) throw new AppError('invalid_filter')
    const { filter, canonical } = parseFilterQuery(platformsOnly(input.filter))
    checkFilter({ ...filter, q: undefined })
    // The list reads its `q` as a query; the rest says what it always did.
    const rest = new URLSearchParams(canonical)
    rest.delete('q')
    const converted = filterToQuery(rest.toString())
    const q = filter.q?.trim()
    if (q) parseQuery(q, OWNER_LIMITS)
    const query = q ? `(${q}) ${converted.query}`.trim() : converted.query
    // The query's own dates (`since:`, `saved:7d`) count days where the
    // list did: its zone.
    const zone = new URLSearchParams(input.filter).get('tz') ?? ''
    if (zone && !zoneOf(zone)) throw new AppError('invalid_filter')
    const tz = converted.tz || (q ? zone : '')
    return {
      ...converted,
      tz,
      query: storedQuery(db, types, query, tz, self),
    }
  }
  const out: Partial<{
    query: string
    sort: string
    order: string
    tz: string
  }> = {}
  if (input.tz !== undefined) {
    if (input.tz && !zoneOf(input.tz)) throw new AppError('invalid_filter')
    out.tz = input.tz
  }
  if (input.sort !== undefined) {
    if (input.sort && !SORTS.has(input.sort))
      throw new AppError('invalid_filter')
    out.sort = input.sort
  }
  if (input.order !== undefined) {
    if (input.order && !['asc', 'desc'].includes(input.order))
      throw new AppError('invalid_filter')
    out.order = input.order
  }
  if (input.query !== undefined) {
    if (input.query.length > MAX_QUERY) throw new AppError('invalid_filter')
    out.query = storedQuery(db, types, input.query, out.tz ?? '', self)
  }
  return out
}

type Row = typeof folders.$inferSelect

function view(
  db: Executor,
  types: Types,
  row: Row,
  counts: StoredCounts | undefined,
): Folder {
  return {
    id: row.id,
    name: row.name,
    query: displayQuery(db, row.query),
    filter: folderFilter(db, types, row),
    sort: row.sort,
    order: row.order,
    tz: row.tz,
    count: counts?.counts.count ?? null,
    types: counts?.counts.types ?? null,
    counted_at: counts?.countedAt.toISOString() ?? null,
    stale: counts?.stale ?? true,
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
export function listFolders(
  db: Executor,
  types: Types = catalogTypes(db),
): Folder[] {
  const rows = db
    .select()
    .from(folders)
    .orderBy(asc(folders.createdAt), asc(folders.id))
    .all()
  const counts = storedCounts(db, rows)
  return rows.map((row) => view(db, types, row, counts.get(row.id)))
}

/** One folder as `listFolders` lists it. */
export function folderView(
  db: Executor,
  id: string,
  types: Types = catalogTypes(db),
): Folder {
  const row = db.select().from(folders).where(eq(folders.id, id)).get()
  if (!row) throw new AppError('not_found')
  return view(db, types, row, storedCounts(db, [row]).get(row.id))
}

export function createFolder(
  db: Database,
  input: FolderInput & { name: string },
  types: Types = catalogTypes(db),
): Folder {
  const name = checkName(input.name)
  const row = db.transaction((tx) => {
    if (sameName(tx, name)) throw duplicate()
    const values = stored(tx, types, input)
    const now = new Date()
    return tx
      .insert(folders)
      .values({ id: newId(), name, ...values, createdAt: now, updatedAt: now })
      .returning()
      .get()
  })
  return view(db, types, row, undefined)
}

/**
 * Rename a folder and/or replace its query, order or zone. Its stored
 * counts stand until it is counted again, stale when the query changed.
 */
export function updateFolder(
  db: Database,
  id: string,
  update: FolderInput,
  types: Types = catalogTypes(db),
): Folder {
  const name = update.name === undefined ? undefined : checkName(update.name)
  const row = db.transaction((tx) => {
    if (name !== undefined && sameName(tx, name, id)) throw duplicate()
    const current = tx.select().from(folders).where(eq(folders.id, id)).get()
    if (!current) throw new AppError('not_found')
    const values = stored(tx, types, { tz: current.tz, ...update }, id)
    const updated = tx
      .update(folders)
      .set({ name, ...values, updatedAt: new Date() })
      .where(eq(folders.id, id))
      .returning()
      .get()!
    // A tag kept only for the old query can go now.
    if (values.query !== undefined) pruneTags(tx)
    return updated
  })
  return view(db, types, row, storedCounts(db, [row]).get(row.id))
}

/**
 * Delete a folder; folders that named it (`folder:`) no longer do, as a
 * folder whose tag was deleted no longer filters on it.
 */
export function deleteFolder(db: Database, id: string): void {
  db.transaction((tx) => {
    const row = tx.delete(folders).where(eq(folders.id, id)).returning().get()
    if (!row) throw new AppError('not_found')
    rewriteFolderQueries(tx, (leaf) =>
      leaf.type === 'atom' && leaf.key === 'folder' && leaf.value === id
        ? null
        : undefined,
    )
    pruneTags(tx)
    revokeOrphanedShares(tx)
  })
}
