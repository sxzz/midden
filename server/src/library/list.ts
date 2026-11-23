import { Buffer } from 'node:buffer'
import { sql, type SQL } from 'drizzle-orm'
import { ENTITY_NAME } from '#capture/graph.ts'
import { canonicalJson, sha256Hex } from '#capture/json.ts'
import { AppError } from '#errors.ts'
import { collectionsById, isUUID } from './read.ts'
import { list, type CollectionView, type Page } from './views.ts'
import type { CaptureContext } from '#capture/context.ts'

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
  sort?: string
  order?: string
  /** Author keys from `listAuthors`; any matches. */
  authors?: string[]
  sensitive?: string
  tag?: string
  /** A saved collection the results relate to directly. */
  relatedTo?: string
  postType?: string
}

export interface Author {
  /** Stable identity: platform, entity type and external id. */
  id: string
  /** The newest captured display name, only a label. */
  name: string
}

const PAGE = 20
const MAX_AUTHORS = 100
const MAX_QUERY = 500
const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i

const invalid = () => new AppError('invalid_filter')
const runes = (value: string) => [...value].length

interface Identity {
  platform: string
  kind: string
  external: string
}

// Each part is escaped, so the key is unambiguous whatever an external id
// contains.
function authorKey(author: Identity): string {
  return [author.platform, author.kind, author.external]
    .map((part) => encodeURIComponent(part))
    .join('/')
}

// Only the canonical encoding names an identity, so one author never makes
// two cursor fingerprints.
function parseAuthorKey(key: string): Identity | undefined {
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

function parseTime(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const at = Date.parse(raw)
  if (!RFC3339.test(raw) || Number.isNaN(at)) throw invalid()
  return at
}

const values = (raw: string | undefined) => (raw ? raw.split(',') : [])

interface Checked {
  filter: Required<Omit<CollectionFilter, 'authors'>> & { authors: string[] }
  authors: Identity[]
  from?: number
  before?: number
}

function check(input: CollectionFilter): Checked {
  const filter = {
    q: input.q ?? '',
    entityType: input.entityType ?? '',
    mediaType: input.mediaType ?? '',
    visibility: input.visibility ?? '',
    savedFrom: input.savedFrom ?? '',
    savedBefore: input.savedBefore ?? '',
    sort: input.sort ?? '',
    order: input.order ?? '',
    authors: input.authors ?? [],
    sensitive: input.sensitive ?? '',
    tag: input.tag ?? '',
    relatedTo: input.relatedTo ?? '',
    postType: input.postType ?? '',
  }
  const oneOf = (value: string, allowed: string[]) =>
    !value || allowed.includes(value)
  if (
    !oneOf(filter.postType, ['post', 'quote', 'repost']) ||
    !oneOf(filter.order, ['desc', 'asc']) ||
    !oneOf(filter.sort, ['captured', 'published', 'storage']) ||
    !oneOf(filter.visibility, ['public', 'private']) ||
    !oneOf(filter.sensitive, ['contains', 'not_contains']) ||
    runes(filter.q) > MAX_QUERY ||
    values(filter.mediaType).some(
      (m) => !['image', 'video', 'text'].includes(m),
    ) ||
    values(filter.entityType).some((t) => !ENTITY_NAME.test(t)) ||
    (filter.relatedTo && !isUUID(filter.relatedTo)) ||
    (filter.tag && !isUUID(filter.tag)) ||
    filter.authors.length > MAX_AUTHORS
  )
    throw invalid()
  const authors = filter.authors.map((key) => {
    const author = parseAuthorKey(key)
    if (!author) throw invalid()
    return author
  })
  const from = parseTime(filter.savedFrom)
  const before = parseTime(filter.savedBefore)
  if (from !== undefined && before !== undefined && from >= before)
    throw invalid()
  return { filter, authors, from, before }
}

interface Cursor {
  at: number
  bytes: number
  id: string
}

function encodeCursor(cursor: Cursor, fingerprint: string): string {
  return Buffer.from(
    JSON.stringify({
      t: cursor.at,
      b: cursor.bytes,
      id: cursor.id,
      f: fingerprint,
    }),
  ).toString('base64url')
}

function decodeCursor(cursor: string, fingerprint: string): Cursor {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (
      value?.f === fingerprint &&
      Number.isSafeInteger(value.t) &&
      Number.isSafeInteger(value.b) &&
      value.b >= 0 &&
      isUUID(value.id)
    )
      return { at: value.t, bytes: value.b, id: value.id }
  } catch {}
  throw new AppError('invalid_cursor')
}

/** The root is an entity of one of these types. */
const rootTypeSQL = (types: string[]) =>
  sql`k.root_kind IN (SELECT value FROM json_each(${list(types)}))`

/** Whose newest catalogued state counts: the account's latest capture. */
const visibilitySQL = (visibility: string) => sql`(
  SELECT s.subject_protected FROM catalog s
  WHERE s.subject_entity_id = k.subject_entity_id
  ORDER BY s.revision_at DESC, s.revision_id DESC LIMIT 1) = ${visibility === 'private' ? 1 : 0}`

function mediaSQL(kinds: string[]): SQL {
  const any: string[] = []
  if (kinds.includes('text')) any.push('NOT k.has_media')
  if (kinds.includes('image')) any.push('k.has_image')
  if (kinds.includes('video')) any.push('k.has_video')
  return sql.raw(`(${any.join(' OR ')})`)
}

/**
 * Tagged directly, or written by an author whose saved collection is
 * tagged.
 */
const tagSQL = (tag: string) => sql`(
  EXISTS (SELECT 1 FROM collection_tags ct
    WHERE ct.collection_id = k.collection_id AND ct.tag_id = ${tag})
  OR k.author_entity_id IN (
    SELECT tagged.root_entity_id FROM collection_tags ct
    JOIN catalog tagged ON tagged.collection_id = ct.collection_id
    WHERE ct.tag_id = ${tag}))`

/** The newest revision of the collection named by `column`. */
const headOf = (column: string) =>
  `(SELECT hk.revision_id FROM catalog hk WHERE hk.collection_id = ${column})`

/**
 * Collections directly related to the requested one, with how: either the
 * candidate's head root points at the requested identity (also by its
 * aliases), or the requested collection's root (in any revision) points at
 * the candidate's identity. A provisional target identity resolves through
 * the candidate's aliases. Context further away (a quoted post's author, an
 * author's bio) never relates.
 */
const relatedEdgesSQL = (requested: string) => sql`
  requested_roots AS MATERIALIZED (
    SELECT identity.platform, identity.kind, identity.external_id
    FROM library rl
    JOIN revision_entities target
      ON target.revision_id = ${sql.raw(headOf('rl.collection_id'))} AND target.is_root = 1
    JOIN entity_versions tv ON tv.id = target.entity_version_id
    JOIN entities identity ON identity.id = tv.entity_id
    WHERE rl.collection_id = ${requested}
    UNION
    SELECT identity.platform, identity.kind, alias.external_id
    FROM library rl
    JOIN collections rc ON rc.id = rl.collection_id
    JOIN revision_entities target
      ON target.revision_id = ${sql.raw(headOf('rc.id'))} AND target.is_root = 1
    JOIN entity_versions tv ON tv.id = target.entity_version_id
    JOIN entities identity ON identity.id = tv.entity_id
    JOIN collection_identity_aliases alias ON alias.collection_id = rc.id
      AND alias.platform = rc.platform AND alias.kind = rc.kind
      AND alias.object_scope = rc.object_scope
    WHERE rl.collection_id = ${requested}
  ),
  requested_targets AS MATERIALIZED (
    SELECT DISTINCT identity.platform, identity.kind, identity.external_id,
      relation.kind AS relation_kind
    FROM collections rc
    JOIN library rl ON rl.collection_id = rc.id
    JOIN revisions rr ON rr.collection_id = rc.id
    JOIN entity_relations relation ON relation.revision_id = rr.id
    JOIN revision_entities owner_root ON owner_root.revision_id = relation.revision_id
      AND owner_root.entity_key = relation.source_key AND owner_root.is_root = 1
    JOIN revision_entities target ON target.revision_id = relation.revision_id
      AND target.entity_key = relation.target_key
    JOIN entity_versions tv ON tv.id = target.entity_version_id
    JOIN entities identity ON identity.id = tv.entity_id
    WHERE rc.id = ${requested}
  ),
  -- CROSS JOIN keeps SQLite walking out from the requested collection's
  -- few identities instead of scanning every relation.
  related_edges AS MATERIALIZED (
    SELECT rv.collection_id, relation.kind
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
    SELECT rv.collection_id, requested_targets.relation_kind
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
    SELECT candidate.id, requested_targets.relation_kind
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
  ),
  related AS MATERIALIZED (
    SELECT collection_id, json_group_array(DISTINCT kind) AS kinds
    FROM related_edges WHERE collection_id <> ${requested}
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

/** The library, filtered, sorted and 20 per page. */
export function listCollections(
  ctx: CaptureContext,
  input: CollectionFilter = {},
  cursor?: string,
): Page<CollectionView> {
  const { filter, authors, from, before } = check(input)
  const fingerprint = sha256Hex(canonicalJson(filter))
  const after = cursor ? decodeCursor(cursor, fingerprint) : undefined
  const related = filter.relatedTo
  const types = values(filter.entityType)
  const conditions: SQL[] = []
  const q = filter.q.trim()
  if (q)
    conditions.push(
      sql`k.search LIKE ${`%${q.replaceAll(/[\\%_]/g, String.raw`\$&`)}%`} ESCAPE '\\'`,
    )
  if (filter.visibility) conditions.push(visibilitySQL(filter.visibility))
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
  if (filter.tag) conditions.push(tagSQL(filter.tag))
  if (filter.postType)
    conditions.push(sql`${postTypeSQL(!!related)} = ${filter.postType}`)
  const where = conditions.length
    ? sql.join(conditions, sql` AND `)
    : sql`1 = 1`
  const by = filter.sort === 'storage' ? 'bytes' : 'at'
  const asc = filter.order === 'asc'
  const direction = sql.raw(asc ? 'ASC' : 'DESC')
  const rows = ctx.db.all<{
    id: string
    at: number
    bytes: number
    relations: string | null
  }>(sql`
    ${related ? sql`WITH ${relatedEdgesSQL(related)}` : sql``}
    SELECT id, at, bytes, relations FROM (
      SELECT k.collection_id AS id,
        ${sql.raw(filter.sort === 'published' ? 'k.published_at' : 'k.observed_at')} AS at,
        k.storage_bytes AS bytes,
        ${sql.raw(related ? 'related.kinds' : 'NULL')} AS relations
      FROM ${sql.raw(related ? RELATED : SAVED)}
      WHERE ${where}
    )
    ${
      after
        ? sql`WHERE (${sql.raw(by)}, id) ${sql.raw(asc ? '>' : '<')} (${by === 'bytes' ? after.bytes : after.at}, ${after.id})`
        : sql``
    }
    ORDER BY ${sql.raw(by)} ${direction}, id ${direction}
    LIMIT ${PAGE + 1}`)
  const page: Page<CollectionView> = { items: [] }
  if (related)
    page.total_storage_bytes =
      ctx.db.get<{ bytes: number }>(sql`
        WITH ${relatedEdgesSQL(related)}
        SELECT coalesce(sum(k.storage_bytes), 0) AS bytes
        FROM ${sql.raw(RELATED)}
        WHERE ${types.length ? rootTypeSQL(types) : sql`1 = 1`}`)?.bytes ?? 0
  const entries = rows.slice(0, PAGE)
  const last = entries.at(-1)
  if (rows.length > PAGE && last)
    page.next_cursor = encodeCursor(last, fingerprint)
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

/**
 * The authors behind saved collections, labelled with the newest display
 * name captured for each. Identity is the entity the root is authored by,
 * never the name: a renamed account stays one author, and two accounts
 * sharing a name stay apart.
 */
export function listAuthors(ctx: CaptureContext): Author[] {
  // One row per author, labelled by its newest captured name: a lone max()
  // makes SQLite read `name` from the row it picked. Prefer a name, then the
  // newest revision.
  const rows = ctx.db.all<{
    platform: string
    kind: string
    external: string
    name: string
  }>(sql`
    SELECT au.platform, au.kind, au.external_id AS external, named.name
    FROM (
      SELECT k.author_entity_id AS author, k.author_name AS name,
        max(printf('%d%015d%s', k.author_name <> '', k.revision_at, k.revision_id))
      FROM ${sql.raw(SAVED)}
      WHERE k.author_entity_id IS NOT NULL
      GROUP BY k.author_entity_id
    ) named
    JOIN entities au ON au.id = named.author`)
  return rows
    .map((row) => ({
      id: authorKey(row),
      // Without a captured name the platform's own id is the only honest
      // label; merging blank names would merge authors.
      name: row.name || row.external,
    }))
    .toSorted((a, b) => byteOrder(a.name, b.name) || byteOrder(a.id, b.id))
}
