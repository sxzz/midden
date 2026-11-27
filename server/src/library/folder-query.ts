// A folder (收藏夹) is a saved query of the query language (`#query/`), kept
// in canonical form with tags and folders named by id, so that renaming them
// changes nothing. Everything that reads a folder compiles its query here:
// the list and its counts, public shares, updates and watches of a folder,
// the agent API. What the list's own filter can say is said by it, so a
// folder converted from a filter runs as that filter did.
import { eq, sql } from 'drizzle-orm'
import { folders, tags } from '#db/schema.ts'
import {
  leaves,
  OWNER_LIMITS,
  parseQuery,
  QueryError,
  type Leaf,
  type QueryNode,
} from '#query/ast.ts'
import { compileQuery, type Types } from '#query/compile.ts'
import { wordTerm } from '#query/convert.ts'
import { printQuery } from '#query/print.ts'
import { SYSTEM } from '#users/principal.ts'
import { filterString, parseFilterQuery } from './filter-query.ts'
import { savedSince, type CollectionFilter, type QueryExtra } from './list.ts'
import { isUUID } from './read.ts'
import type { Executor } from '#db/client.ts'

/**
 * The entity types the catalog holds, for what has no platforms at hand
 * (tests, scripts): the platforms' own (`Platforms.types()`) otherwise.
 */
export function catalogTypes(db: Executor): Types {
  const kinds = db
    .all<{ kind: string }>(
      sql`SELECT DISTINCT root_kind AS kind FROM catalog WHERE root_kind IS NOT NULL`,
    )
    .map((row) => row.kind)
  return {
    open: true,
    platforms: [...new Set(kinds.map((k) => k.split('.', 1)[0]!))].toSorted(),
    posts: kinds.filter((k) => !k.endsWith('.profile')).toSorted(),
    accounts: kinds.filter((k) => k.endsWith('.profile')).toSorted(),
  }
}

const SPACES = /\s+/

/** What a folder keeps. */
export interface FolderQuery {
  /** Canonical; tags and folders by id. Empty selects everything. */
  query: string
  sort: string
  order: string
  /** Where its relative dates (`saved:7d`) count days; UTC when empty. */
  tz: string
}

/** A folder's query compiled for the list: the filter, and SQL besides. */
export interface FolderSelection {
  filter: CollectionFilter
  extra?: QueryExtra
}

/** A query as the owner's (the web app's and folders') compile it. */
function compileOwned(
  db: Executor,
  types: Types,
  folder: Pick<FolderQuery, 'query' | 'tz'>,
  options: { now?: number; within?: string; prefix?: string } = {},
) {
  return compileQuery(folder.query, {
    db,
    types,
    kind: 'all',
    // A folder's query is the admin's, whoever reads what it selects.
    principal: SYSTEM,
    filter: {},
    // A folder may be everything but something.
    scoped: true,
    limits: OWNER_LIMITS,
    prefix: options.prefix ?? 'folder',
    ...(folder.tz ? { timeZone: folder.tz } : {}),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.within ? { within: options.within } : {}),
  })
}

/** What a folder selects, in its own order. */
export function folderSelection(
  db: Executor,
  types: Types,
  folder: FolderQuery,
  now?: number,
): FolderSelection {
  const compiled = compileOwned(db, types, folder, { now })
  const order = {
    ...(folder.sort ? { sort: folder.sort } : {}),
    ...(folder.order ? { order: folder.order } : {}),
  }
  if (!compiled) return { filter: order }
  return {
    filter: { ...compiled.filter, ...order },
    ...(compiled.extra ? { extra: compiled.extra } : {}),
  }
}

/**
 * The list's query string when the filter alone says what the folder
 * does (what the web's filter controls can show), with its order and zone;
 * null when it needs the query. Its `q` is query text, as the list reads
 * it: the search's words, each read back as that word.
 */
export function folderFilter(
  db: Executor,
  types: Types,
  folder: FolderQuery,
): string | null {
  try {
    const { filter, extra } = folderSelection(db, types, folder)
    if (extra) return null
    const words = filter.q?.split(SPACES).filter(Boolean) ?? []
    return parseFilterQuery(
      filterString({
        ...filter,
        q: words.map((word) => wordTerm(word)).join(' '),
        ...(filter.savedWithin && folder.tz ? { timeZone: folder.tz } : {}),
      }),
    ).canonical
  } catch {
    return null
  }
}

/** The folder rows a query names, followed into the folders they name. */
function namedFolders(
  db: Executor,
  node: QueryNode,
  seen = new Set<string>(),
): { id: string; query: string; tz: string }[] {
  const out: { id: string; query: string; tz: string }[] = []
  for (const { leaf } of leaves(node)) {
    if (leaf.type !== 'atom' || leaf.key !== 'folder' || seen.has(leaf.value))
      continue
    seen.add(leaf.value)
    const row = db
      .select({ id: folders.id, query: folders.query, tz: folders.tz })
      .from(folders)
      .where(eq(folders.id, leaf.value))
      .get()
    if (!row) continue
    out.push(row)
    try {
      const inner = parseQuery(row.query, OWNER_LIMITS)
      if (inner) out.push(...namedFolders(db, inner, seen))
    } catch {}
  }
  return out
}

const HOUR = 3_600_000
const SPAN = /^\d+[dh]$/

/**
 * What a folder's count is of: its query and zone, the day (or hour) its
 * relative dates start from, and what the folders it names say. A count
 * of another key is out of date.
 */
export function folderKey(
  db: Executor,
  folder: Pick<FolderQuery, 'query' | 'tz'>,
  now = Date.now(),
): string {
  let node: QueryNode | undefined
  try {
    node = parseQuery(folder.query, OWNER_LIMITS)
  } catch {
    return folder.query
  }
  if (!node) return `\n${folder.tz}`
  const parts: unknown[] = [folder.query, folder.tz]
  for (const { leaf } of leaves(node)) {
    if (leaf.type !== 'atom') continue
    if (!['within', 'saved'].includes(leaf.key) || !SPAN.test(leaf.value))
      continue
    parts.push(
      leaf.value.endsWith('h')
        ? Math.floor(now / HOUR)
        : savedSince(leaf.value, folder.tz || undefined, now),
    )
  }
  const named = namedFolders(db, node)
  if (named.length) parts.push(named)
  return JSON.stringify(parts)
}

/** Tag ids a folder's query names, wanted or not. */
export function tagIdsOf(query: string): string[] {
  try {
    const node = parseQuery(query, OWNER_LIMITS)
    if (!node) return []
    return leaves(node).flatMap(({ leaf }) =>
      leaf.type === 'atom' && leaf.key === 'tag' ? [leaf.value] : [],
    )
  } catch {
    return []
  }
}

/** A tree with some terms replaced, or dropped (`null`). */
function rewrite(
  node: QueryNode,
  change: (leaf: Leaf) => Leaf | null,
): QueryNode | null {
  switch (node.type) {
    case 'and':
    case 'or': {
      const items = node.items
        .map((item) => rewrite(item, change))
        .filter((item): item is QueryNode => !!item)
      if (!items.length) return null
      return items.length === 1 ? items[0]! : { ...node, items }
    }
    case 'not': {
      const item = rewrite(node.item, change)
      return item ? { ...node, item } : null
    }
    default:
      return change(node)
  }
}

/**
 * Rewrite every folder whose query names a term `change` replaces or drops:
 * a tag merged into another or deleted, a folder deleted. A dropped term
 * goes from its AND, its OR and its `-`; a folder left with nothing selects
 * everything, as one whose filter lost its last tag did.
 */
export function rewriteFolderQueries(
  tx: Executor,
  change: (leaf: Leaf) => Leaf | null | undefined,
): void {
  for (const folder of tx
    .select({ id: folders.id, query: folders.query })
    .from(folders)
    .all()) {
    let node: QueryNode | undefined
    try {
      node = parseQuery(folder.query, OWNER_LIMITS)
    } catch {
      continue
    }
    if (!node) continue
    let changed = false
    const next = rewrite(node, (leaf) => {
      const result = change(leaf)
      if (result === undefined) return leaf
      changed = true
      return result
    })
    if (!changed) continue
    tx.update(folders)
      .set({ query: next ? printQuery(next) : '' })
      .where(eq(folders.id, folder.id))
      .run()
  }
}

/**
 * In folders whose query wants a tag (`tag:` not under `-`) and also
 * excludes it (`-tag:`), drop the exclusion.
 */
export function dropExcludedWanted(tx: Executor, tag: string): void {
  for (const folder of tx
    .select({ id: folders.id, query: folders.query })
    .from(folders)
    .all()) {
    let node: QueryNode | undefined
    try {
      node = parseQuery(folder.query, OWNER_LIMITS)
    } catch {
      continue
    }
    if (!node) continue
    const named = leaves(node).filter(
      ({ leaf }) =>
        leaf.type === 'atom' && leaf.key === 'tag' && leaf.value === tag,
    )
    if (named.every((l) => l.negated) || named.every((l) => !l.negated))
      continue
    const drop = (n: QueryNode): QueryNode | null => {
      if (
        n.type === 'not' &&
        n.item.type === 'atom' &&
        n.item.key === 'tag' &&
        n.item.value === tag
      )
        return null
      if (n.type === 'and' || n.type === 'or') {
        const items = n.items
          .map((item) => drop(item))
          .filter((item): item is QueryNode => !!item)
        if (!items.length) return null
        return items.length === 1 ? items[0]! : { ...n, items }
      }
      return n
    }
    const next = drop(node)
    tx.update(folders)
      .set({ query: next ? printQuery(next) : '' })
      .where(eq(folders.id, folder.id))
      .run()
  }
}

/** Names for ids: a folder's query as people read it. */
export function displayQuery(db: Executor, query: string): string {
  let node: QueryNode | undefined
  try {
    node = parseQuery(query, OWNER_LIMITS)
  } catch {
    return query
  }
  if (!node) return ''
  const named = rewrite(node, (leaf) => {
    if (leaf.type !== 'atom' || !isUUID(leaf.value)) return leaf
    if (leaf.key === 'tag') {
      const name = db
        .select({ name: tags.name })
        .from(tags)
        .where(eq(tags.id, leaf.value))
        .get()?.name
      return name ? { ...leaf, value: name } : leaf
    }
    if (leaf.key === 'folder') {
      const name = db
        .select({ name: folders.name })
        .from(folders)
        .where(eq(folders.id, leaf.value))
        .get()?.name
      return name ? { ...leaf, value: name } : leaf
    }
    return leaf
  })
  return named ? printQuery(named) : ''
}

/**
 * A query as a folder keeps it: canonical, tags and folders by id, read
 * with the owner's limits and compiled once to be sure it runs (a folder
 * that would include itself, an unknown tag or folder, is a `QueryError`).
 * `self` is the folder being saved.
 */
export function storedQuery(
  db: Executor,
  types: Types,
  text: string,
  tz: string,
  self?: string,
): string {
  const node = parseQuery(text, OWNER_LIMITS)
  if (!node) return ''
  const ids = rewrite(node, (leaf) => {
    if (leaf.type !== 'atom') return leaf
    if (leaf.key === 'tag') {
      const row = db
        .select({ id: tags.id })
        .from(tags)
        .where(
          isUUID(leaf.value)
            ? eq(tags.id, leaf.value.toLowerCase())
            : eq(tags.name, leaf.value),
        )
        .get()
      if (!row)
        throw new QueryError(
          `Unknown tag ${leaf.value}.`,
          leaf.start,
          'unknown_tag',
          { value: leaf.value },
        )
      return { ...leaf, value: row.id }
    }
    if (leaf.key === 'folder') {
      const row = db
        .select({ id: folders.id })
        .from(folders)
        .where(
          isUUID(leaf.value)
            ? eq(folders.id, leaf.value.toLowerCase())
            : eq(folders.name, leaf.value),
        )
        .get()
      if (!row)
        throw new QueryError(
          `No folder ${leaf.value}.`,
          leaf.start,
          'unknown_folder',
          { value: leaf.value },
        )
      if (row.id === self)
        throw new QueryError(
          'A folder cannot include itself.',
          leaf.start,
          'folder_self',
        )
      return { ...leaf, value: row.id }
    }
    return leaf
  })
  const stored = ids ? printQuery(ids) : ''
  compileOwned(db, types, { query: stored, tz }, { within: self })
  return stored
}
