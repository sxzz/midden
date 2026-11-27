// The agent API's query parameters: read, checked with messages an agent
// can act on, resolved (handles, tag names) and turned into the library's
// own filter (`CollectionFilter`), which the web's list reads too. What was
// applied is echoed back in a canonical form, and page cursors are bound to
// the query they came from.
import { eq, sql } from 'drizzle-orm'
import { canonicalJson, sha256Hex } from '#capture/json.ts'
import { folders, tags } from '#db/schema.ts'
import { parseFilterQuery } from '#library/filter-query.ts'
import {
  authorKey,
  defaultRelMin,
  parseAuthorKey,
  type CollectionFilter,
  type Identity,
  type Narrowing,
  type QueryExtra,
} from '#library/list.ts'
import { isUUID } from '#library/read.ts'
import { fold } from '#library/search-text.ts'
import { compileQuery } from '#query/compile.ts'
import { AgentError, invalid, notFound } from './errors.ts'
import { VIEWS, type View } from './shape.ts'
import type { Executor } from '#db/client.ts'
import type { Reader } from '#library/views.ts'

/** The entity types the archive's platforms keep, by kind. */
export interface TypeCatalog {
  platforms: string[]
  posts: string[]
  accounts: string[]
}

/** What reads need: the database, media links and the entity types. */
export interface AgentReader extends Reader {
  types: TypeCatalog
}

/** Query parameters; a repeated key has several values. */
export type Params = Record<string, string[]>

export type Kind = 'posts' | 'accounts'

export const PAGE_SIZE = 20
export const MAX_PAGE_SIZE = 50

const FILTER_KEYS = [
  'q',
  'platform',
  'media_type',
  'protected',
  'sensitive',
  'saved_from',
  'saved_before',
  'saved_within',
  'time_zone',
  'author',
  'tag',
  'tag_mode',
  'not_tag',
  'post_type',
  'source_state',
  'related_to',
  'rel_of',
  'rel',
  'rel_min',
] as const
const PAGE_KEYS = ['folder', 'sort', 'order', 'size', 'cursor', 'view']
/** Keys that take a list: comma-separated, repeated, or both. */
const LIST_KEYS = new Set([
  'platform',
  'media_type',
  'author',
  'tag',
  'not_tag',
  'rel_of',
])
/** What a folder's filter cannot be narrowed by: it would widen it. */
const NOT_NARROWING = [
  'tag',
  'tag_mode',
  'not_tag',
  'related_to',
  'rel_of',
  'rel',
  'rel_min',
]
const SORTS: Record<Kind, string[]> = {
  posts: ['relevance', 'published', 'saved', 'updated', 'storage'],
  accounts: [
    'relevance',
    'published',
    'saved',
    'updated',
    'storage',
    'followers',
    'following',
  ],
}
const SIZE = /^\d{1,3}$/
const REL_MIN = /^[1-9]\d{0,5}$/
const REF = /^(?:([a-z][\w-]*):)?@([\w.]{1,64})$/

const oneOf = (key: string, value: string, allowed: readonly string[]) => {
  if (!allowed.includes(value))
    throw invalid(`${key} must be one of: ${allowed.join(', ')}.`)
  return value
}

/** The values of a key, lists split at commas. */
function values(params: Params, key: string): string[] {
  const raw = params[key] ?? []
  if (!LIST_KEYS.has(key)) {
    if (raw.length > 1) throw invalid(`${key} is given more than once.`)
    return raw.map((v) => v.trim()).filter(Boolean)
  }
  return raw.flatMap((v) => v.split(',').map((s) => s.trim())).filter(Boolean)
}

const single = (params: Params, key: string) => values(params, key)[0]

function boolean(params: Params, key: string): boolean | undefined {
  const value = single(params, key)
  if (value === undefined) return undefined
  return oneOf(key, value, ['true', 'false']) === 'true'
}

/** Reject keys the endpoint does not know, so a typo is not ignored. */
export function checkKeys(params: Params, allowed: readonly string[]): void {
  const unknown = Object.keys(params).filter((key) => !allowed.includes(key))
  if (unknown.length)
    throw invalid(
      `Unknown parameter${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. See /agent.md.`,
    )
}

export const searchKeys = (kind: Kind) =>
  [...FILTER_KEYS, ...PAGE_KEYS].filter(
    (key) => kind === 'posts' || key !== 'post_type',
  )

export const FOLDER_FILTER_KEYS: readonly string[] = FILTER_KEYS

export function pageSize(params: Params): number {
  const raw = single(params, 'size')
  if (raw === undefined) return PAGE_SIZE
  const size = Number(raw)
  if (!SIZE.test(raw) || size < 1 || size > MAX_PAGE_SIZE)
    throw invalid(`size must be a whole number from 1 to ${MAX_PAGE_SIZE}.`)
  return size
}

export function viewOf(params: Params): View {
  const raw = single(params, 'view')
  return raw === undefined ? 'compact' : (oneOf('view', raw, VIEWS) as View)
}

// --- Accounts and tags by reference ---------------------------------------

/** An account found by reference: its identity, and its saved collection. */
export interface FoundAccount {
  key: string
  identity: Identity
  collectionId?: string
}

/** Saved accounts on a platform whose newest captured username is this. */
function byHandle(
  db: Executor,
  platform: string,
  handle: string,
): string | undefined {
  const at = `@${fold(handle)}`
  const kind = `${platform}.profile`
  // The name column of the trigram index holds `@handle` lines; one or two
  // letters are too short for it, and are matched row by row.
  const rows =
    [...at].length >= 3
      ? db.all<{ id: string; names: string }>(sql`
          SELECT k.collection_id AS id, k.search_name AS names
          FROM catalog_fts f CROSS JOIN catalog k ON k.id = f.rowid
          JOIN library l ON l.collection_id = k.collection_id
          WHERE catalog_fts MATCH ${`name : "${at}"`} AND k.root_kind = ${kind}
          ORDER BY k.revision_at DESC, k.collection_id`)
      : db.all<{ id: string; names: string }>(sql`
          SELECT k.collection_id AS id, k.search_name AS names
          FROM catalog k JOIN library l ON l.collection_id = k.collection_id
          WHERE k.root_kind = ${kind} AND instr(k.search_name, ${at})
          ORDER BY k.revision_at DESC, k.collection_id`)
  return rows.find((row) => row.names.split('\n').includes(at))?.id
}

/** A saved collection's account identity, when it is an account. */
function accountOf(db: Executor, id: string): FoundAccount | undefined {
  const row = db.get<{
    platform: string
    kind: string
    external: string
  }>(sql`
    SELECT e.platform, e.kind, e.external_id AS external
    FROM catalog k JOIN library l ON l.collection_id = k.collection_id
    JOIN entities e ON e.id = k.root_entity_id
    WHERE k.collection_id = ${id} AND k.root_kind LIKE '%.profile'`)
  if (!row) return undefined
  const identity = {
    platform: row.platform,
    kind: row.kind,
    external: row.external,
  }
  return { key: authorKey(identity), identity, collectionId: id }
}

/** The saved account (collection) a key names, if any. */
function savedByKey(db: Executor, identity: Identity): string | undefined {
  return db.get<{ id: string }>(sql`
    SELECT k.collection_id AS id FROM entities e
    JOIN catalog k ON k.root_entity_id = e.id
    JOIN library l ON l.collection_id = k.collection_id
    WHERE e.platform = ${identity.platform} AND e.kind = ${identity.kind}
      AND e.external_id = ${identity.external}
    ORDER BY k.revision_at DESC LIMIT 1`)?.id
}

/**
 * An account by any of the ways the API names one: its collection id, its
 * key (`x/x.profile/123`), `x:@handle`, or `@handle` with `platform`.
 * Handles are matched against saved accounts' newest captured usernames.
 */
export function findAccount(
  r: AgentReader,
  ref: string,
  platform?: string,
): FoundAccount {
  if (isUUID(ref)) {
    const found = accountOf(r.db, ref.toLowerCase())
    if (!found) throw notFound(`No saved account has the id ${ref}.`)
    return found
  }
  const handle = REF.exec(ref)
  if (handle) {
    const on = handle[1] ?? platform
    if (!on)
      throw invalid(
        `${ref} names a handle without a platform: write x:${ref} or instagram:${ref}, or give platform.`,
      )
    if (!r.types.platforms.includes(on))
      throw invalid(`Unknown platform ${on}.`)
    const id = byHandle(r.db, on, handle[2]!)
    if (!id)
      throw notFound(`No saved account on ${on} has the handle @${handle[2]}.`)
    return accountOf(r.db, id)!
  }
  const identity = parseAuthorKey(ref)
  if (identity?.kind.endsWith('.profile')) {
    const id = savedByKey(r.db, identity)
    return { key: ref, identity, ...(id ? { collectionId: id } : {}) }
  }
  throw invalid(
    `${ref} is not an account: give a collection id, an account key (x/x.profile/123) or x:@handle.`,
  )
}

/** A saved account's collection id, from any reference to it. */
export function savedAccount(
  r: AgentReader,
  ref: string,
  platform?: string,
): string {
  const found = findAccount(r, ref, platform)
  if (!found.collectionId) throw notFound(`The account ${ref} is not saved.`)
  return found.collectionId
}

/** Tags by id or exact name. */
export function findTags(
  db: Executor,
  refs: readonly string[],
): { id: string; name: string }[] {
  return refs.map((ref) => {
    const found = db
      .select({ id: tags.id, name: tags.name })
      .from(tags)
      .where(isUUID(ref) ? eq(tags.id, ref.toLowerCase()) : eq(tags.name, ref))
      .get()
    if (!found)
      throw invalid(`Unknown tag: ${ref}. GET /agent/v1/tags lists them.`)
    return found
  })
}

function tagNames(db: Executor, ids: string): { id: string; name: string }[] {
  if (!ids) return []
  return ids.split(',').map((id) => ({
    id,
    name:
      db.select({ name: tags.name }).from(tags).where(eq(tags.id, id)).get()
        ?.name ?? '',
  }))
}

// --- Parameters to filters -------------------------------------------------

/**
 * The types a list of `kind` reads: those of the given platforms, or of
 * every platform. A folder (`folder`) keeps both kinds of each platform it
 * names, or leaves types out.
 */
function typesOf(
  r: AgentReader,
  kind: Kind | 'folder',
  platforms: string[],
): string | undefined {
  const on = (type: string) =>
    !platforms.length || platforms.includes(type.split('.', 1)[0]!)
  if (kind === 'folder')
    return platforms.length
      ? [...r.types.posts, ...r.types.accounts].filter(on).toSorted().join(',')
      : undefined
  return r.types[kind].filter(on).toSorted().join(',')
}

/** The filter the parameters describe, resolved, for a list of `kind`. */
export function filterOf(
  r: AgentReader,
  kind: Kind | 'folder',
  params: Params,
): CollectionFilter {
  const platforms = [...new Set(values(params, 'platform'))].toSorted()
  for (const p of platforms)
    if (!r.types.platforms.includes(p))
      throw invalid(
        `Unknown platform ${p}; the archive has: ${r.types.platforms.join(', ')}.`,
      )
  const platform = platforms.length === 1 ? platforms[0] : undefined
  const media = values(params, 'media_type')
  for (const m of media) oneOf('media_type', m, ['image', 'video', 'text'])
  const isProtected = boolean(params, 'protected')
  const sensitive = boolean(params, 'sensitive')
  const tagMode = single(params, 'tag_mode')
  if (tagMode) oneOf('tag_mode', tagMode, ['any', 'all'])
  const postType = single(params, 'post_type')
  if (postType) oneOf('post_type', postType, ['post', 'quote', 'repost'])
  const sourceState = single(params, 'source_state')
  if (sourceState) oneOf('source_state', sourceState, ['deleted', 'suspended'])
  const rel = single(params, 'rel')
  if (rel) oneOf('rel', rel, ['following', 'followers', 'mutual'])
  const relOf = values(params, 'rel_of')
  if (Boolean(rel) !== relOf.length > 0)
    throw invalid('rel_of and rel come together: whose follows, and which way.')
  const relMin = single(params, 'rel_min')
  if (relMin !== undefined) {
    if (!relOf.length) throw invalid('rel_min needs rel_of.')
    if (!REL_MIN.test(relMin) || Number(relMin) > relOf.length)
      throw invalid(
        `rel_min must be from 1 to ${relOf.length}, the accounts in rel_of.`,
      )
  }
  const sort = single(params, 'sort')
  if (sort && kind !== 'folder') oneOf('sort', sort, SORTS[kind])
  const order = single(params, 'order')
  if (order) oneOf('order', order, ['desc', 'asc'])
  const relatedTo = single(params, 'related_to')
  const timeZone = single(params, 'time_zone')
  const q = single(params, 'q')?.replaceAll(/\s+/g, ' ')
  return {
    q,
    entityType: typesOf(r, kind, platforms),
    mediaType: media.length
      ? [...new Set(media)].toSorted().join(',')
      : undefined,
    visibility:
      isProtected === undefined
        ? undefined
        : isProtected
          ? 'private'
          : 'public',
    sensitive:
      sensitive === undefined
        ? undefined
        : sensitive
          ? 'contains'
          : 'not_contains',
    savedFrom: single(params, 'saved_from'),
    savedBefore: single(params, 'saved_before'),
    savedWithin: single(params, 'saved_within'),
    timeZone,
    authors: values(params, 'author').map(
      (ref) => findAccount(r, ref, platform).key,
    ),
    tag: findTags(r.db, values(params, 'tag'))
      .map((t) => t.id)
      .join(','),
    tagMode,
    notTag: findTags(r.db, values(params, 'not_tag'))
      .map((t) => t.id)
      .join(','),
    postType,
    sourceState,
    relatedTo: relatedTo
      ? isUUID(relatedTo)
        ? relatedTo.toLowerCase()
        : savedAccount(r, relatedTo, platform)
      : undefined,
    relOf: relOf.map((ref) => findAccount(r, ref, platform).key),
    rel,
    relMin,
    sort,
    order,
  }
}

/**
 * A filter in the API's own terms, canonically: lists sorted, tags with
 * their names, platforms instead of types, defaults left out.
 */
export function describe(
  r: AgentReader,
  filter: CollectionFilter,
  kind?: Kind,
): Record<string, unknown> {
  const types = filter.entityType ? filter.entityType.split(',') : []
  const platforms = [...new Set(types.map((t) => t.split('.', 1)[0]!))]
  // A list of one kind always names its types; they say a platform only
  // when they are fewer than all.
  const everyPlatform = kind
    ? r.types[kind].every((t) => types.includes(t))
    : !types.length
  const tagList = (ids: string | undefined) =>
    tagNames(
      r.db,
      [...new Set((ids ?? '').split(',').filter(Boolean))].toSorted().join(','),
    )
  const tag = tagList(filter.tag)
  const notTag = tagList(filter.notTag)
  const relOf = [...new Set(filter.relOf)].toSorted()
  const out: Record<string, unknown> = {
    ...(filter.q?.trim() ? { q: filter.q.trim() } : {}),
    ...(!everyPlatform && platforms.length
      ? { platform: platforms.toSorted() }
      : {}),
    ...(filter.mediaType
      ? { media_type: [...new Set(filter.mediaType.split(','))].toSorted() }
      : {}),
    ...(filter.visibility
      ? { protected: filter.visibility === 'private' }
      : {}),
    ...(filter.sensitive ? { sensitive: filter.sensitive === 'contains' } : {}),
    ...(filter.savedFrom ? { saved_from: filter.savedFrom } : {}),
    ...(filter.savedBefore ? { saved_before: filter.savedBefore } : {}),
    ...(filter.savedWithin
      ? {
          saved_within: filter.savedWithin,
          time_zone: filter.timeZone || 'UTC',
        }
      : {}),
    ...(filter.authors?.length
      ? { author: [...new Set(filter.authors)].toSorted() }
      : {}),
    ...(tag.length ? { tag } : {}),
    ...(tag.length > 1 && filter.tagMode === 'all' ? { tag_mode: 'all' } : {}),
    ...(notTag.length ? { not_tag: notTag } : {}),
    ...(filter.postType ? { post_type: filter.postType } : {}),
    ...(filter.sourceState ? { source_state: filter.sourceState } : {}),
    ...(filter.relatedTo ? { related_to: filter.relatedTo } : {}),
    ...(relOf.length
      ? {
          rel_of: relOf,
          rel: filter.rel,
          rel_min: filter.relMin
            ? Number(filter.relMin)
            : defaultRelMin(relOf.length),
        }
      : {}),
  }
  return out
}

/** The library's query string for a filter, as folders store it. */
export function filterQueryString(filter: CollectionFilter): string {
  const params = new URLSearchParams()
  const set = (key: string, value: string | undefined) => {
    if (value) params.set(key, value)
  }
  set('q', filter.q)
  set('entity_type', filter.entityType)
  set('media_type', filter.mediaType)
  set('visibility', filter.visibility)
  set('saved_from', filter.savedFrom)
  set('saved_before', filter.savedBefore)
  set('saved_within', filter.savedWithin)
  set('time_zone', filter.timeZone)
  set('sort', filter.sort)
  set('order', filter.order)
  for (const author of filter.authors ?? []) params.append('author', author)
  set('sensitive', filter.sensitive)
  set('tag', filter.tag)
  set('tag_mode', filter.tagMode)
  set('not_tag', filter.notTag)
  set('related_to', filter.relatedTo)
  set('post_type', filter.postType)
  set('source_state', filter.sourceState)
  for (const key of filter.relOf ?? []) params.append('rel_of', key)
  set('rel', filter.rel)
  set('rel_min', filter.relMin)
  return params.toString()
}

// --- Searches ---------------------------------------------------------------

export interface Search {
  /** The filter the list starts from: the folder's, or the request's. */
  filter: CollectionFilter
  /** With a folder, the request's own conditions, which only narrow it. */
  narrow?: Narrowing
  /** What the query (`q`) says that the filter cannot. */
  extra?: QueryExtra
  /** The query in its canonical form. */
  parsed?: string
  applied: Record<string, unknown>
  /** What a cursor is bound to. */
  bound: string
  size: number
  view: View
  cursor?: string
}

export interface FolderRef {
  id: string
  name: string
  filter: CollectionFilter
}

export function findFolder(db: Executor, id: string): FolderRef {
  const row = isUUID(id)
    ? db.select().from(folders).where(eq(folders.id, id.toLowerCase())).get()
    : undefined
  if (!row) throw notFound(`No folder has the id ${id}.`)
  return {
    id: row.id,
    name: row.name,
    filter: parseFilterQuery(row.filter).filter,
  }
}

/** Parameters that scope a search the way `since:` or `from:` would. */
const SCOPES = [
  'saved_from',
  'saved_before',
  'saved_within',
  'author',
  'folder',
  'tag',
  'rel_of',
  'related_to',
]

/** Read a search of `kind` from its parameters. */
export function readSearch(r: AgentReader, kind: Kind, params: Params): Search {
  checkKeys(params, searchKeys(kind))
  const size = pageSize(params)
  const view = viewOf(params)
  const folderId = single(params, 'folder')
  const widening = NOT_NARROWING.filter((key) => values(params, key).length)
  if (folderId && widening.length)
    throw invalid(
      `With folder, other conditions only narrow it; ${widening.join(', ')} cannot be added. Save a folder with them instead.`,
    )
  // `q` is the query language; the rest the list's own filter.
  const { q: _, ...structured } = params
  const q = single(params, 'q')
  const own = filterOf(r, kind, structured)
  const compiled = q
    ? compileQuery(q, {
        db: r.db,
        types: r.types,
        kind,
        filter: own,
        folder: !!folderId,
        canScope: !widening.length,
        scoped: SCOPES.some((key) => values(params, key).length),
        ...(own.timeZone ? { timeZone: own.timeZone } : {}),
      })
    : undefined
  const lowered = compiled?.filter ?? own
  const folder = folderId ? findFolder(r.db, folderId) : compiled?.folder
  let filter = lowered
  let narrow: Narrowing | undefined
  if (folder) {
    const {
      sort,
      order,
      relatedTo,
      tag,
      tagMode,
      notTag,
      relOf,
      rel,
      relMin,
      ...rest
    } = lowered
    narrow = rest
    filter = {
      ...folder.filter,
      ...(sort ? { sort } : {}),
      ...(order ? { order } : {}),
    }
  }
  const searching = !!(filter.q?.trim() || narrow?.q?.trim())
  let sort = filter.sort || ''
  if (!SORTS[kind].includes(sort)) sort = ''
  if (!sort || sort === 'relevance') sort = searching ? 'relevance' : 'updated'
  const applied = {
    ...describe(r, own, kind),
    ...(compiled ? { q: compiled.parsed } : {}),
    ...(folder ? { folder: { id: folder.id, name: folder.name } } : {}),
    sort,
    ...(sort === 'relevance' ? {} : { order: filter.order || 'desc' }),
  }
  const bound = sha256Hex(
    canonicalJson({ kind, filter, narrow, query: compiled?.parsed }),
  ).slice(0, 24)
  const cursor = single(params, 'cursor')
  return {
    filter,
    narrow,
    ...(compiled?.extra ? { extra: compiled.extra } : {}),
    ...(compiled ? { parsed: compiled.parsed } : {}),
    applied,
    bound,
    size,
    view,
    ...(cursor ? { cursor } : {}),
  }
}

/** The list's own cursor (base64url) after what it is bound to. */
export const encodeCursor = (bound: string, inner: string) =>
  `${bound}.${inner}`

const CURSOR = /^([\da-f]{24})\.([\w-]+)$/

/**
 * The list's cursor inside one of ours: `invalid_request` when it is none,
 * `cursor_mismatch` when it came from another query.
 */
export function decodeCursor(bound: string, cursor: string): string {
  const parts = CURSOR.exec(cursor)
  if (!parts) throw invalid('cursor is not one this API gave out.')
  const [, b, c] = parts as unknown as [string, string, string]
  if (b !== bound)
    throw new AgentError(
      'cursor_mismatch',
      'The cursor belongs to another query. Repeat the same parameters, or start again without cursor.',
    )
  return c
}
