import { Buffer } from 'node:buffer'
import { sql, type SQL } from 'drizzle-orm'
import { ENTITY_NAME } from '#capture/graph.ts'
import { canonicalJson, sha256Hex } from '#capture/json.ts'
import { AppError } from '#errors.ts'
import { FOLLOW_SETS, followSetSQL, type FollowSet } from './follows.ts'
import { collectionsById, isUUID } from './read.ts'
import { searchHits, type SearchHits } from './search.ts'
import { list, type CollectionView, type Page } from './views.ts'
import type { CaptureContext } from '#capture/context.ts'
import type { Executor } from '#db/client.ts'

/** Library filters, as given in the query string. Empty means unset. */
export interface CollectionFilter {
  q?: string
  /** Comma-separated entity types of the root; any matches. */
  entityType?: string
  /** Comma-separated `image`, `video`, `text`; any matches. */
  mediaType?: string
  /** `public` or `private`: whether the author's account is protected. */
  visibility?: string
  /** RFC 3339; save time, inclusive. */
  savedFrom?: string
  /** RFC 3339; save time, exclusive. */
  savedBefore?: string
  /**
   * `<n>d`: saved on one of the last n calendar days, today included,
   * resolved on every request. Not combined with the two above.
   */
  savedWithin?: string
  /** IANA time zone whose days `savedWithin` counts; UTC by default. */
  timeZone?: string
  /**
   * `published`, `saved` (added to the library), `updated` (newest capture,
   * the default), `storage`, or an account's `followers` or `following`
   * count, which only orders a list of accounts alone and is `updated`
   * otherwise. With a search, results come in relevance tiers first and
   * these order each tier; `relevance`, the default then, orders a tier by
   * how well each result matches, and is `updated` without a search.
   */
  sort?: string
  order?: string
  /** Author keys from `listAuthors`; any matches. */
  authors?: string[]
  sensitive?: string
  /**
   * `deleted` or `suspended`: what the platform is confirmed to say of it
   * now (原站已删除, 账号已被封禁); its archived content stays.
   */
  sourceState?: string
  /**
   * Tag ids, comma-separated; a collection has a tag when it is tagged or
   * its author's saved profile is. `tagMode` `all` asks for every one of
   * them, otherwise any will do.
   */
  tag?: string
  tagMode?: string
  /** Tag ids, comma-separated, none of which a collection may have. */
  notTag?: string
  /** A saved collection the results relate to directly. */
  relatedTo?: string
  postType?: string
  /**
   * Account keys (as authors') whose current follows select: the accounts
   * in `rel` of them, and posts by them. Given with `rel` or not at all.
   */
  relOf?: string[]
  /** `following`, `followers` or `mutual`, as each of `relOf` sees them. */
  rel?: string
  /**
   * How many of `relOf` an account must be in `rel` of, from 1 to all of
   * them: 2 by default when there are several, else the one.
   */
  relMin?: string
}

export interface Author {
  /** Stable identity: platform, entity type and external id. */
  id: string
  /** The newest captured display name, only a label. */
  name: string
  /** Saved collections by this author. */
  count: number
}

const PAGE = 20
const MAX_AUTHORS = 100
const MAX_QUERY = 500
const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i

const invalid = () => new AppError('invalid_filter')
const runes = (value: string) => [...value].length

export interface Identity {
  platform: string
  kind: string
  external: string
}

// Each part is escaped, so the key is unambiguous whatever an external id
// contains.
export function authorKey(author: Identity): string {
  return [author.platform, author.kind, author.external]
    .map((part) => encodeURIComponent(part))
    .join('/')
}

// Only the canonical encoding names an identity, so one author never makes
// two cursor fingerprints.
export function parseAuthorKey(key: string): Identity | undefined {
  const parts = key.split('/')
  if (parts.length !== 3) return undefined
  const decoded: string[] = []
  for (const part of parts) {
    let value: string
    try {
      value = decodeURIComponent(part)
    } catch {
      return undefined
    }
    if (!value || runes(value) > MAX_QUERY || value.includes('\0'))
      return undefined
    decoded.push(value)
  }
  const [platform, kind, external] = decoded as [string, string, string]
  const author = { platform, kind, external }
  return authorKey(author) === key ? author : undefined
}

/**
 * How many perspectives an account must relate to when the filter does not
 * say: two of several (shared follows), else the one.
 */
export const defaultRelMin = (perspectives: number) =>
  Math.min(2, Math.max(1, perspectives))

/** A threshold: a count without leading zeros. */
const REL_MIN = /^[1-9]\d{0,5}$/

const WITHIN = /^([1-9]\d{0,3})d$/

/** A time zone Temporal knows, or undefined. */
function zoneOf(raw: string): string | undefined {
  if (raw.length > 64) return undefined
  try {
    return Temporal.Now.zonedDateTimeISO(raw).timeZoneId
  } catch {
    return undefined
  }
}

/**
 * Where `saved_within` starts at `now`: the start of the day n - 1 days
 * before today in the zone, as the web's date fields count days. Undefined
 * when either value is invalid.
 */
export function savedSince(
  within: string,
  zone = 'UTC',
  now = Date.now(),
): number | undefined {
  const days = WITHIN.exec(within)?.[1]
  const id = zoneOf(zone)
  if (!days || !id) return undefined
  return Temporal.Instant.fromEpochMilliseconds(now)
    .toZonedDateTimeISO(id)
    .toPlainDate()
    .subtract({ days: Number(days) - 1 })
    .toZonedDateTime(id).epochMilliseconds
}

function parseTime(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const at = Date.parse(raw)
  if (!RFC3339.test(raw) || Number.isNaN(at)) throw invalid()
  return at
}

const values = (raw: string | undefined) => (raw ? raw.split(',') : [])

const MAX_TAGS = 100

/** A comma-separated set of tag ids, each once and in order. */
export const tagList = (raw: string | undefined) =>
  [...new Set(values(raw))].toSorted().join(',')

/** Ids, not too many, and none both wanted and excluded. */
function validTags(tag: string, notTag: string): boolean {
  const wanted = values(tag)
  const excluded = values(notTag)
  return (
    wanted.length <= MAX_TAGS &&
    excluded.length <= MAX_TAGS &&
    [...wanted, ...excluded].every((id) => isUUID(id)) &&
    wanted.every((id) => !excluded.includes(id))
  )
}

interface Checked {
  filter: Required<Omit<CollectionFilter, 'authors' | 'relOf'>> & {
    authors: string[]
    relOf: string[]
  }
  authors: Identity[]
  /** The accounts whose follows select, with `filter.rel`. */
  relOf: Identity[]
  /** How many of them an account must relate to. */
  relMin: number
  from?: number
  before?: number
  /** A narrowing's own filter, as part of the cursor's fingerprint. */
  narrow?: Checked['filter']
}

function check(input: CollectionFilter): Checked {
  const filter = {
    q: input.q ?? '',
    entityType: input.entityType ?? '',
    mediaType: input.mediaType ?? '',
    visibility: input.visibility ?? '',
    savedFrom: input.savedFrom ?? '',
    savedBefore: input.savedBefore ?? '',
    savedWithin: input.savedWithin ?? '',
    timeZone: input.timeZone ?? '',
    sort: input.sort ?? '',
    order: input.order ?? '',
    authors: input.authors ?? [],
    sensitive: input.sensitive ?? '',
    // One set of tags is one filter, and one cursor fingerprint.
    tag: tagList(input.tag),
    tagMode: input.tagMode ?? '',
    notTag: tagList(input.notTag),
    relatedTo: input.relatedTo ?? '',
    postType: input.postType ?? '',
    sourceState: input.sourceState ?? '',
    // One set of perspectives is one filter, and one cursor fingerprint.
    relOf: [...new Set(input.relOf)].toSorted(),
    rel: input.rel ?? '',
    relMin: input.relMin ?? '',
  }
  const oneOf = (value: string, allowed: string[]) =>
    !value || allowed.includes(value)
  if (
    !oneOf(filter.postType, ['post', 'quote', 'repost']) ||
    !oneOf(filter.order, ['desc', 'asc']) ||
    !oneOf(filter.sort, [
      'relevance',
      'saved',
      'updated',
      'published',
      'storage',
      'followers',
      'following',
    ]) ||
    !oneOf(filter.visibility, ['public', 'private']) ||
    !oneOf(filter.sensitive, ['contains', 'not_contains']) ||
    !oneOf(filter.sourceState, ['deleted', 'suspended']) ||
    runes(filter.q) > MAX_QUERY ||
    values(filter.mediaType).some(
      (m) => !['image', 'video', 'text'].includes(m),
    ) ||
    values(filter.entityType).some((t) => !ENTITY_NAME.test(t)) ||
    (filter.relatedTo && !isUUID(filter.relatedTo)) ||
    !oneOf(filter.tagMode, ['any', 'all']) ||
    !validTags(filter.tag, filter.notTag) ||
    filter.authors.length > MAX_AUTHORS ||
    !oneOf(filter.rel, FOLLOW_SETS) ||
    // Perspectives and a mode come together or not at all.
    Boolean(filter.rel) !== filter.relOf.length > 0 ||
    (filter.relMin && (!filter.relOf.length || !REL_MIN.test(filter.relMin)))
  )
    throw invalid()
  // A perspective is an account: only accounts follow.
  const relOf = filter.relOf.map((key) => {
    const account = parseAuthorKey(key)
    if (!account?.kind.endsWith('.profile')) throw invalid()
    return account
  })
  const relMin = filter.relMin
    ? Number(filter.relMin)
    : defaultRelMin(relOf.length)
  if (relOf.length && relMin > relOf.length) throw invalid()
  // The default is written one way: left out.
  if (relMin === defaultRelMin(relOf.length)) filter.relMin = ''
  const authors = filter.authors.map((key) => {
    const author = parseAuthorKey(key)
    if (!author) throw invalid()
    return author
  })
  let from = parseTime(filter.savedFrom)
  const before = parseTime(filter.savedBefore)
  if (from !== undefined && before !== undefined && from >= before)
    throw invalid()
  if (filter.timeZone && !zoneOf(filter.timeZone)) throw invalid()
  if (filter.savedWithin) {
    if (from !== undefined || before !== undefined) throw invalid()
    from = savedSince(filter.savedWithin, filter.timeZone || undefined)
    if (from === undefined) throw invalid()
  }
  return { filter, authors, relOf, relMin, from, before }
}

interface Cursor {
  at: number
  bytes: number
  id: string
  /** With a search: the relevance tier and the score within it. */
  tier: number
  score: number
}

function encodeCursor(
  cursor: Cursor,
  fingerprint: string,
  ranked: boolean,
): string {
  return Buffer.from(
    JSON.stringify({
      t: cursor.at,
      b: cursor.bytes,
      id: cursor.id,
      ...(ranked ? { g: cursor.tier, s: cursor.score } : {}),
      f: fingerprint,
    }),
  ).toString('base64url')
}

function decodeCursor(
  cursor: string,
  fingerprint: string,
  ranked: boolean,
): Cursor {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (
      value?.f === fingerprint &&
      Number.isSafeInteger(value.t) &&
      Number.isSafeInteger(value.b) &&
      value.b >= 0 &&
      isUUID(value.id) &&
      (!ranked ||
        (Number.isSafeInteger(value.g) &&
          value.g >= 1 &&
          value.g <= 4 &&
          Number.isFinite(value.s)))
    )
      return {
        at: value.t,
        bytes: value.b,
        id: value.id,
        tier: ranked ? value.g : 0,
        score: ranked ? value.s : 0,
      }
  } catch {}
  throw new AppError('invalid_cursor')
}

/**
 * The catalog column an account count order reads, the one kept for its
 * direction, when the list can only hold accounts: the filter or its
 * narrowing names account types alone.
 * Anywhere else (a 帖子 tab of a folder saved with this order) it is ignored,
 * as a folder keeps one order for both of its tabs.
 */
function countColumn(checked: Checked, asc: boolean): string | undefined {
  const { sort } = checked.filter
  if (sort !== 'followers' && sort !== 'following') return undefined
  const accounts = [checked.filter, checked.narrow].some((f) => {
    const types = values(f?.entityType)
    return types.length > 0 && types.every((t) => t.endsWith('.profile'))
  })
  return accounts ? `k.${sort}_${asc ? 'asc' : 'desc'}` : undefined
}

/** The root is an entity of one of these types. */
const rootTypeSQL = (types: string[]) =>
  sql`k.root_kind IN (SELECT value FROM json_each(${list(types)}))`

/**
 * Whose newest catalogued state counts: the account's latest capture. A
 * page of the list asks it of the few collections it reads. Reading all of
 * them (`whole`, a count), it is asked once for each account (an account's
 * posts are many) and each collection looks itself up in that set; the `+`
 * keeps SQLite from starting at the accounts and reading `k` through its
 * index, which is slower when most collections are selected.
 */
function visibilitySQL(visibility: string, whole: boolean): SQL {
  const protectedAs = visibility === 'private' ? 1 : 0
  const newest = (account: string) => `(
    SELECT s.subject_protected FROM catalog s
    WHERE s.subject_entity_id = ${account}
    ORDER BY s.revision_at DESC, s.revision_id DESC LIMIT 1)`
  return whole
    ? sql`+k.subject_entity_id IN (
        SELECT account.id FROM (
          SELECT DISTINCT subject_entity_id AS id FROM catalog
          WHERE subject_entity_id IS NOT NULL) account
        WHERE ${sql.raw(newest('account.id'))} = ${protectedAs})`
    : sql`${sql.raw(newest('k.subject_entity_id'))} = ${protectedAs}`
}

function mediaSQL(kinds: string[]): SQL {
  const any: string[] = []
  if (kinds.includes('text')) any.push('NOT k.has_media')
  if (kinds.includes('image')) any.push('k.has_image')
  if (kinds.includes('video')) any.push('k.has_video')
  return sql.raw(`(${any.join(' OR ')})`)
}

/**
 * Collections with any of these tags: tagged directly, or written by an
 * author whose saved collection is tagged. Listed as one set from the
 * `collection_tags` index, so SQLite starts from the few tagged rows
 * instead of testing every saved collection.
 */
const taggedSQL = (tags: string[]) => sql`(
  SELECT ct.collection_id FROM collection_tags ct
  WHERE ct.tag_id IN (SELECT value FROM json_each(${list(tags)}))
  UNION
  SELECT authored.collection_id FROM collection_tags ct
  JOIN catalog tagged ON tagged.collection_id = ct.collection_id
  JOIN catalog authored ON authored.author_entity_id = tagged.root_entity_id
  WHERE ct.tag_id IN (SELECT value FROM json_each(${list(tags)})))`

/** Any of the tags, or each of them; and none of the excluded ones. */
function tagSQL(tag: string, mode: string, notTag: string): SQL[] {
  const wanted = values(tag)
  const conditions =
    mode === 'all'
      ? wanted.map((id) => sql`k.collection_id IN ${taggedSQL([id])}`)
      : wanted.length
        ? [sql`k.collection_id IN ${taggedSQL(wanted)}`]
        : []
  if (notTag)
    conditions.push(sql`k.collection_id NOT IN ${taggedSQL(values(notTag))}`)
  return conditions
}

/** The newest revision of the collection named by `column`. */
const headOf = (column: string) =>
  `(SELECT hk.revision_id FROM catalog hk WHERE hk.collection_id = ${column})`

/**
 * Collections directly related to each requested one, with how, as
 * `related_edges(requested_id, collection_id, kind)`: either the candidate's
 * head root points at the requested identity (also by its aliases), or the
 * requested collection's root (in any revision) points at the candidate's
 * identity. A provisional target identity resolves through the candidate's
 * aliases. Context further away (a quoted post's author, an author's bio)
 * never relates. `requested` selects the requested collections as `id`; a
 * collection may relate to itself, and candidates need not be saved.
 */
export const relatedEdgesSQL = (requested: SQL) => sql`
  requested AS MATERIALIZED (${requested}),
  requested_roots AS MATERIALIZED (
    SELECT rl.collection_id AS requested_id,
      identity.platform, identity.kind, identity.external_id
    FROM requested
    CROSS JOIN library rl ON rl.collection_id = requested.id
    JOIN revision_entities target
      ON target.revision_id = ${sql.raw(headOf('rl.collection_id'))} AND target.is_root = 1
    JOIN entity_versions tv ON tv.id = target.entity_version_id
    JOIN entities identity ON identity.id = tv.entity_id
    UNION
    SELECT rl.collection_id, identity.platform, identity.kind, alias.external_id
    FROM requested
    CROSS JOIN library rl ON rl.collection_id = requested.id
    JOIN collections rc ON rc.id = rl.collection_id
    JOIN revision_entities target
      ON target.revision_id = ${sql.raw(headOf('rc.id'))} AND target.is_root = 1
    JOIN entity_versions tv ON tv.id = target.entity_version_id
    JOIN entities identity ON identity.id = tv.entity_id
    JOIN collection_identity_aliases alias ON alias.collection_id = rc.id
      AND alias.platform = rc.platform AND alias.kind = rc.kind
      AND alias.object_scope = rc.object_scope
  ),
  requested_targets AS MATERIALIZED (
    SELECT DISTINCT rc.id AS requested_id,
      identity.platform, identity.kind, identity.external_id,
      relation.kind AS relation_kind
    FROM requested
    CROSS JOIN collections rc ON rc.id = requested.id
    JOIN library rl ON rl.collection_id = rc.id
    JOIN revisions rr ON rr.collection_id = rc.id
    JOIN entity_relations relation ON relation.revision_id = rr.id
    JOIN revision_entities owner_root ON owner_root.revision_id = relation.revision_id
      AND owner_root.entity_key = relation.source_key AND owner_root.is_root = 1
    JOIN revision_entities target ON target.revision_id = relation.revision_id
      AND target.entity_key = relation.target_key
    JOIN entity_versions tv ON tv.id = target.entity_version_id
    JOIN entities identity ON identity.id = tv.entity_id
  ),
  -- CROSS JOIN keeps SQLite walking out from the requested collections'
  -- few identities instead of scanning every relation.
  related_edges AS MATERIALIZED (
    SELECT requested_roots.requested_id, rv.collection_id, relation.kind
    FROM requested_roots
    CROSS JOIN entities related_identity ON related_identity.platform = requested_roots.platform
      AND related_identity.kind = requested_roots.kind
      AND related_identity.external_id = requested_roots.external_id
    CROSS JOIN entity_versions related_version ON related_version.entity_id = related_identity.id
    CROSS JOIN revision_entities related ON related.entity_version_id = related_version.id
    CROSS JOIN entity_relations relation ON relation.revision_id = related.revision_id
      AND relation.target_key = related.entity_key
    CROSS JOIN revision_entities candidate_root ON candidate_root.revision_id = relation.revision_id
      AND candidate_root.entity_key = relation.source_key AND candidate_root.is_root = 1
    CROSS JOIN revisions rv ON rv.id = relation.revision_id
    WHERE rv.id = ${sql.raw(headOf('rv.collection_id'))}
    UNION ALL
    SELECT requested_targets.requested_id, rv.collection_id,
      requested_targets.relation_kind
    FROM requested_targets
    CROSS JOIN entities candidate_identity ON candidate_identity.platform = requested_targets.platform
      AND candidate_identity.kind = requested_targets.kind
      AND candidate_identity.external_id = requested_targets.external_id
    CROSS JOIN entity_versions candidate_version ON candidate_version.entity_id = candidate_identity.id
    CROSS JOIN revision_entities candidate_root ON candidate_root.entity_version_id = candidate_version.id
      AND candidate_root.is_root = 1
    CROSS JOIN revisions rv ON rv.id = candidate_root.revision_id
    WHERE rv.id = ${sql.raw(headOf('rv.collection_id'))}
    UNION ALL
    SELECT requested_targets.requested_id, candidate.id,
      requested_targets.relation_kind
    FROM requested_targets
    CROSS JOIN collection_identity_aliases alias ON alias.external_id = requested_targets.external_id
    JOIN collections candidate ON candidate.id = alias.collection_id
      AND candidate.platform = alias.platform AND candidate.kind = alias.kind
      AND candidate.object_scope = alias.object_scope
    JOIN revision_entities candidate_root
      ON candidate_root.revision_id = ${sql.raw(headOf('candidate.id'))}
      AND candidate_root.is_root = 1
    JOIN entity_versions candidate_version ON candidate_version.id = candidate_root.entity_version_id
    JOIN entities candidate_identity ON candidate_identity.id = candidate_version.entity_id
      AND candidate_identity.platform = requested_targets.platform
      AND candidate_identity.kind = requested_targets.kind
  )`

/** One collection's related ones, with how, as `related(collection_id, kinds)`. */
const relatedSQL = (requested: string) => sql`
  ${relatedEdgesSQL(sql`SELECT ${requested} AS id`)},
  related AS MATERIALIZED (
    SELECT collection_id, json_group_array(DISTINCT kind) AS kinds
    FROM related_edges WHERE collection_id <> requested_id
    GROUP BY collection_id
  )`

/**
 * Repost is relative to the requested collection when there is one;
 * otherwise any saved repost edge into the root makes it one. A quote has
 * its own text plus an outgoing quoted edge.
 */
const postTypeSQL = (related: boolean) => sql`CASE
  WHEN ${
    related
      ? sql`EXISTS (SELECT 1 FROM json_each(related.kinds) WHERE value = 'reposted')`
      : sql`k.root_entity_id IN (
          SELECT version.entity_id FROM entity_relations edge
          JOIN revision_entities target ON target.revision_id = edge.revision_id
            AND target.entity_key = edge.target_key
          JOIN entity_versions version ON version.id = target.entity_version_id
          JOIN revisions owner ON owner.id = edge.revision_id
          JOIN library saved ON saved.collection_id = owner.collection_id
          WHERE edge.kind = 'reposted')`
  } THEN 'repost'
  WHEN k.quotes THEN 'quote'
  ELSE 'post' END`

/** Saved collections, by their catalog row `k`. */
const SAVED = `catalog k JOIN library l ON l.collection_id = k.collection_id`

/** Saved collections related to the requested one, from `related`. */
const RELATED = `related CROSS JOIN catalog k ON k.collection_id = related.collection_id
  JOIN library l ON l.collection_id = k.collection_id`

interface Selection {
  checked: Checked
  /** The `WITH` clause the source needs, if any. */
  ctes: SQL
  /**
   * Saved collections as `k` and `l`, maybe narrowed to related ones; with
   * a search, only what it finds, with its tier and score as `hits`.
   */
  source: string
  where: SQL
  /** Whether the source has `hits` to rank by. */
  ranked: boolean
}

/**
 * Conditions a checked filter puts on the saved collections `k` and `l`. A
 * post's type is relative to the requested collection when the list is one
 * collection's related ones.
 */
function conditionsOf(
  checked: Checked,
  related: boolean,
  whole: boolean,
): SQL[] {
  const { filter, authors, from, before } = checked
  const types = values(filter.entityType)
  // The search (`q`) is not a condition here: `select` drives from it.
  const conditions: SQL[] = []
  if (filter.visibility)
    conditions.push(visibilitySQL(filter.visibility, whole))
  if (from !== undefined) conditions.push(sql`l.created_at >= ${from}`)
  if (before !== undefined) conditions.push(sql`l.created_at < ${before}`)
  if (filter.mediaType) conditions.push(mediaSQL(values(filter.mediaType)))
  if (types.length) conditions.push(rootTypeSQL(types))
  if (authors.length)
    conditions.push(
      sql`k.author_entity_id IN (
        SELECT au.id FROM json_each(${list(authors.map((a) => [a.platform, a.kind, a.external]))}) wanted
        JOIN entities au ON au.platform = wanted.value ->> 0
          AND au.kind = wanted.value ->> 1 AND au.external_id = wanted.value ->> 2)`,
    )
  if (filter.sensitive)
    conditions.push(
      sql`k.has_sensitive = ${filter.sensitive === 'contains' ? 1 : 0}`,
    )
  conditions.push(...tagSQL(filter.tag, filter.tagMode, filter.notTag))
  // An account's own profile and its posts share the subject, so one set of
  // accounts selects both tabs; `catalog_subject` looks each one up.
  if (checked.relOf.length)
    conditions.push(
      sql`k.subject_entity_id IN ${followSetSQL(checked.relOf, filter.rel as FollowSet, checked.relMin)}`,
    )
  if (filter.postType)
    conditions.push(sql`${postTypeSQL(related)} = ${filter.postType}`)
  // Few have one, so the partial index lists them all.
  if (filter.sourceState)
    conditions.push(
      sql`k.collection_id IN (SELECT id FROM collections
        WHERE source_state = ${filter.sourceState})`,
    )
  return conditions
}

/**
 * A filter that only narrows another one: its conditions are added to the
 * other's, so it can never select more. It names no related collection, no
 * tag (wanted or not) and no follows, and the other filter's order stands.
 */
export type Narrowing = Omit<
  CollectionFilter,
  | 'relatedTo'
  | 'tag'
  | 'tagMode'
  | 'notTag'
  | 'relOf'
  | 'rel'
  | 'relMin'
  | 'sort'
  | 'order'
>

/**
 * The saved collections a filter selects, unordered; with a narrowing, only
 * those it selects too. A search drives the query from what it finds; when
 * both filters search, the narrowing's ranks and the other's only selects.
 * `whole` is for reading every collection it selects, not a page of them.
 */
function select(
  db: Executor,
  input: CollectionFilter,
  narrow?: Narrowing,
  whole = false,
): Selection {
  const checked = check(input)
  const related = checked.filter.relatedTo
  const conditions = conditionsOf(checked, !!related, whole)
  if (narrow) {
    const extra = check(narrow)
    const { relatedTo, tag, tagMode, notTag, relOf, rel, relMin } = extra.filter
    if (relatedTo || tag || tagMode || notTag || relOf.length || rel || relMin)
      throw invalid()
    conditions.push(...conditionsOf(extra, !!related, whole))
    checked.narrow = extra.filter
  }
  const searches = [checked.filter.q, checked.narrow?.q ?? '']
    .map((q, i) => searchHits(db, q, `hits_${i}`))
    .filter((hits): hits is SearchHits => !!hits)
  const ranked = searches.pop()
  for (const other of searches)
    conditions.push(sql`k.id IN (SELECT rowid FROM ${sql.raw(other.name)})`)
  const ctes = [
    ...(related ? [relatedSQL(related)] : []),
    ...searches.map((s) => s.ctes),
    ...(ranked ? [ranked.ctes] : []),
  ]
  // A search drives: SQLite starts from the few rows it finds.
  const source = ranked
    ? related
      ? `${RELATED} JOIN ${ranked.name} hits ON hits.rowid = k.id`
      : `${ranked.name} hits CROSS JOIN catalog k ON k.id = hits.rowid
        JOIN library l ON l.collection_id = k.collection_id`
    : related
      ? RELATED
      : SAVED
  return {
    checked,
    ctes: ctes.length ? sql`WITH ${sql.join(ctes, sql`, `)}` : sql``,
    source,
    where: conditions.length ? sql.join(conditions, sql` AND `) : sql`1 = 1`,
    ranked: !!ranked,
  }
}

/** Throw `invalid_filter` unless the list accepts this filter. */
export function checkFilter(input: CollectionFilter): void {
  check(input)
}

/** How many saved collections a filter selects, over all pages. */
export interface FilterCounts {
  count: number
  /** By the root's entity type; types with none are left out. */
  types: Record<string, number>
}

/**
 * What the list shows for a filter, counted over all pages by type; with a
 * narrowing, only what it selects too.
 */
export function countCollections(
  db: Executor,
  input: CollectionFilter = {},
  narrow?: Narrowing,
): FilterCounts {
  return countSelection(db, select(db, input, narrow, true))
}

function countSelection(
  db: Executor,
  { ctes, source, where }: Selection,
): FilterCounts {
  const rows = db.all<{ type: string | null; count: number }>(sql`
    ${ctes}
    SELECT k.root_kind AS type, count(*) AS count
    FROM ${sql.raw(source)} WHERE ${where} GROUP BY k.root_kind`)
  const counts: FilterCounts = { count: 0, types: {} }
  for (const row of rows) {
    counts.count += row.count
    if (row.type) counts.types[row.type] = row.count
  }
  return counts
}

/**
 * Whether a filter's count tests every saved collection, so that it can share
 * a pass with others (`countCollectionsTogether`). One that starts from a few
 * rows (a search, related collections, tags, authors, accounts' follows) is
 * cheaper counted on its own, as its plan does.
 */
export function sharesCountPass(input: CollectionFilter): boolean {
  const { filter, relOf } = check(input)
  return (
    !filter.q &&
    !filter.relatedTo &&
    !filter.tag &&
    !filter.authors.length &&
    !relOf.length
  )
}

/**
 * Counts for filters that `sharesCountPass`, as `countCollections` gives
 * each, from one pass over the library with each filter as a `FILTER` clause
 * of the same aggregate. Reading the catalog is most of what a count costs,
 * and a library of folders would read it once per folder.
 */
export function countCollectionsTogether(
  db: Executor,
  inputs: readonly CollectionFilter[],
): FilterCounts[] {
  const result = inputs.map((): FilterCounts => ({ count: 0, types: {} }))
  if (!inputs.length) return result
  const columns = inputs.map((input, i) => {
    const { source, where } = select(db, input, undefined, true)
    // Anything but the saved collections would count a different set.
    if (source !== SAVED) throw invalid()
    return sql`count(*) FILTER (WHERE ${where}) AS ${sql.raw(`c${i}`)}`
  })
  const rows = db.all<Record<string, number | string | null>>(sql`
    SELECT k.root_kind AS type, ${sql.join(columns, sql`, `)}
    FROM ${sql.raw(SAVED)} GROUP BY k.root_kind`)
  for (const row of rows) {
    for (const [i, counts] of result.entries()) {
      const count = row[`c${i}`] as number
      if (!count) continue
      counts.count += count
      if (row.type) counts.types[row.type as string] = count
    }
  }
  return result
}

/** Which of these collections the list shows for a filter, on any page. */
export function selectedAmong(
  db: Executor,
  input: CollectionFilter,
  ids: readonly string[],
): Set<string> {
  if (!ids.length) return new Set()
  const { ctes, source, where } = select(db, input)
  return new Set(
    db
      .all<{ id: string }>(
        sql`
      ${ctes}
      SELECT k.collection_id AS id FROM ${sql.raw(source)}
      WHERE ${where}
        AND k.collection_id IN (SELECT value FROM json_each(${list(ids)}))`,
      )
      .map((row) => row.id),
  )
}

/**
 * Whether `k` meets the filter on its own, not through its author. Two
 * conditions reach a post through its author: a wanted tag the author's
 * saved profile carries, and the 关系 filter, whose set is accounts and
 * which selects posts by their author. Everything else (search, media,
 * dates, the author filter, visibility, `related_to`, the post type) is
 * about the item itself; an excluded tag only takes items out.
 */
function directSQL(checked: Checked): SQL {
  const { tag, tagMode } = checked.filter
  const own = (tags: string[]) => sql`k.collection_id IN (
    SELECT ct.collection_id FROM collection_tags ct
    WHERE ct.tag_id IN (SELECT value FROM json_each(${list(tags)})))`
  const wanted = values(tag)
  const conditions =
    tagMode === 'all'
      ? wanted.map((id) => own([id]))
      : wanted.length
        ? [own(wanted)]
        : []
  // An account is its own subject; a post's is its author.
  if (checked.relOf.length)
    conditions.push(sql`k.subject_entity_id = k.root_entity_id`)
  return conditions.length ? sql.join(conditions, sql` AND `) : sql`1`
}

/**
 * What updating everything a filter selects covers, up to `limit`, in no set
 * order: every account it selects, and every post except those it selects
 * only through their author (see `directSQL`) when that author's profile is
 * among the accounts, whose own update reads its posts as the update's
 * options say. A post it selects on its own merits is updated by itself
 * even then: the profile's update need not reach it.
 */
export function updateSelection(
  db: Executor,
  input: CollectionFilter,
  limit: number,
): string[] {
  const { checked, ctes, source, where } = select(db, input)
  return db
    .all<{ id: string }>(
      sql`
      ${ctes}
      SELECT id FROM (
        SELECT id, profile, direct, account,
          max(profile) OVER (PARTITION BY account) AS covered
        FROM (
          SELECT k.collection_id AS id,
            coalesce(k.root_kind LIKE '%.profile', 0) AS profile,
            ${directSQL(checked)} AS direct,
            CASE WHEN k.root_kind LIKE '%.profile' THEN k.root_entity_id
              ELSE k.author_entity_id END AS account
          FROM ${sql.raw(source)}
          WHERE ${where}))
      WHERE profile OR direct OR account IS NULL OR NOT covered
      LIMIT ${limit}`,
    )
    .map((row) => row.id)
}

/**
 * The library, filtered, sorted and 20 per page (or `size`); with a
 * narrowing, only what it selects too.
 */
export function listCollections(
  ctx: Pick<CaptureContext, 'db' | 'blobs'>,
  input: CollectionFilter = {},
  cursor?: string,
  narrow?: Narrowing,
  size = PAGE,
): Page<CollectionView> {
  const { checked, ctes, source, where, ranked } = select(ctx.db, input, narrow)
  const { filter } = checked
  const fingerprint = sha256Hex(
    canonicalJson(checked.narrow ? { filter, narrow: checked.narrow } : filter),
  )
  const after = cursor ? decodeCursor(cursor, fingerprint, ranked) : undefined
  const related = filter.relatedTo
  const types = values(filter.entityType)
  // Without a search there is nothing to be relevant to.
  const relevance = ranked && (!filter.sort || filter.sort === 'relevance')
  const by = filter.sort === 'storage' ? 'bytes' : 'at'
  const asc = filter.order === 'asc'
  const direction = sql.raw(asc ? 'ASC' : 'DESC')
  // A count rides in the time's place.
  const time =
    countColumn(checked, asc) ??
    (filter.sort === 'published'
      ? 'k.published_at'
      : filter.sort === 'saved'
        ? 'l.created_at'
        : 'k.observed_at')
  const key = (cursor: Cursor) => (by === 'bytes' ? cursor.bytes : cursor.at)
  // Tiers come first, best first, each in the chosen order; under
  // relevance the score orders a tier, lower first, then the newest.
  const seek = after
    ? relevance
      ? sql`WHERE tier > ${after.tier} OR (tier = ${after.tier}
          AND (score > ${after.score} OR (score = ${after.score} AND id < ${after.id})))`
      : ranked
        ? sql`WHERE tier > ${after.tier} OR (tier = ${after.tier}
            AND (${sql.raw(by)}, id) ${sql.raw(asc ? '>' : '<')} (${key(after)}, ${after.id}))`
        : sql`WHERE (${sql.raw(by)}, id) ${sql.raw(asc ? '>' : '<')} (${key(after)}, ${after.id})`
    : sql``
  const order = relevance
    ? sql`tier, score, id DESC`
    : sql`${sql.raw(ranked ? 'tier, ' : '')}${sql.raw(by)} ${direction}, id ${direction}`
  const rows = ctx.db.all<Cursor & { relations: string | null }>(sql`
    ${ctes}
    SELECT id, at, bytes, relations, tier, score FROM (
      -- The id comes from the table whose index orders the page, so SQLite
      -- reads library_created in order for saved time instead of sorting.
      SELECT ${sql.raw(filter.sort === 'saved' ? 'l' : 'k')}.collection_id AS id,
        ${sql.raw(time)} AS at,
        k.storage_bytes AS bytes,
        ${sql.raw(related ? 'related.kinds' : 'NULL')} AS relations,
        ${sql.raw(ranked ? 'hits.tier' : '0')} AS tier,
        ${sql.raw(ranked ? 'hits.score' : '0')} AS score
      FROM ${sql.raw(source)}
      WHERE ${where}
    )
    ${seek}
    ORDER BY ${order}
    LIMIT ${size + 1}`)
  const page: Page<CollectionView> = { items: [] }
  if (related)
    page.total_storage_bytes =
      ctx.db.get<{ bytes: number }>(sql`
        WITH ${relatedSQL(related)}
        SELECT coalesce(sum(k.storage_bytes), 0) AS bytes
        FROM ${sql.raw(RELATED)}
        WHERE ${types.length ? rootTypeSQL(types) : sql`1 = 1`}`)?.bytes ?? 0
  const entries = rows.slice(0, size)
  const last = entries.at(-1)
  if (rows.length > size && last)
    page.next_cursor = encodeCursor(last, fingerprint, ranked)
  const loaded = collectionsById(
    ctx,
    entries.map((e) => e.id),
  )
  for (const entry of entries) {
    const item = loaded.get(entry.id)
    if (!item) continue
    item.storage_bytes = entry.bytes
    const relations = entry.relations
      ? (JSON.parse(entry.relations) as string[]).toSorted()
      : []
    if (relations.length) item.relation_types = relations
    page.items.push(item)
  }
  return page
}

const byteOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

const AUTHOR_PAGE = 50

export interface AuthorFilter {
  /** Part of the name or the platform's id, any case. */
  q?: string
  /** Where the previous page ended. */
  cursor?: string
  /** Only these author keys, unpaged: labels for a saved selection. */
  authors?: string[]
}

/**
 * The authors behind saved collections, labelled with the newest display
 * name captured for each, those with the most saved posts first. Identity is
 * the entity the root is authored by, never the name: a renamed account
 * stays one author, and two accounts sharing a name stay apart. With a
 * filter, only the collections it selects count, and only their authors are
 * listed.
 */
export function listAuthors(
  ctx: CaptureContext,
  input: AuthorFilter = {},
  within: CollectionFilter = {},
): Page<Author> {
  const q = (input.q ?? '').trim().toLocaleLowerCase()
  const wanted = input.authors ?? []
  const offset = input.cursor ? Number(input.cursor) : 0
  if (
    runes(q) > MAX_QUERY ||
    wanted.length > MAX_AUTHORS ||
    wanted.some((key) => !parseAuthorKey(key)) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    (input.cursor && String(offset) !== input.cursor)
  )
    throw invalid()
  const { ctes, source, where } = select(ctx.db, within)
  // One row per author, labelled by its newest captured name: the name rides
  // at the end of the key max() picks, which prefers a name, then the newest
  // revision. A unit separator ends the revision id.
  const rows = ctx.db.all<{
    platform: string
    kind: string
    external: string
    name: string
    count: number
  }>(sql`
    ${ctes}
    SELECT au.platform, au.kind, au.external_id AS external,
      substr(named.newest, 17 + instr(substr(named.newest, 17), char(31)))
        AS name, named.count
    FROM (
      SELECT k.author_entity_id AS author, count(*) AS count,
        max(printf('%d%015d%s', k.author_name <> '', k.revision_at,
          k.revision_id) || char(31) || k.author_name) AS newest
      FROM ${sql.raw(source)}
      WHERE k.author_entity_id IS NOT NULL AND ${where}
      GROUP BY k.author_entity_id
    ) named
    JOIN entities au ON au.id = named.author`)
  let authors = rows.map((row) => ({
    id: authorKey(row),
    // Without a captured name the platform's own id is the only honest
    // label; merging blank names would merge authors.
    name: row.name || row.external,
    count: row.count,
    external: row.external,
  }))
  if (wanted.length) {
    const keys = new Set(wanted)
    authors = authors.filter((author) => keys.has(author.id))
  } else if (q)
    authors = authors.filter(
      (author) =>
        author.name.toLocaleLowerCase().includes(q) ||
        author.external.toLocaleLowerCase().includes(q),
    )
  authors.sort(
    (a, b) =>
      b.count - a.count || byteOrder(a.name, b.name) || byteOrder(a.id, b.id),
  )
  const end = wanted.length ? authors.length : offset + AUTHOR_PAGE
  const page: Page<Author> = {
    items: authors
      .slice(wanted.length ? 0 : offset, end)
      .map(({ id, name, count }) => ({ id, name, count })),
  }
  if (end < authors.length) page.next_cursor = String(end)
  return page
}
