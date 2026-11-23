import { Buffer } from 'node:buffer'
import { sql, type SQL } from 'drizzle-orm'
import { ENTITY_NAME } from '#capture/graph.ts'
import { canonicalJson, sha256Hex } from '#capture/json.ts'
import { AppError } from '#errors.ts'
import { AUTHORED_BY } from './entities.ts'
import { collectionsById, isUUID, storageOf } from './read.ts'
import { head, list, type CollectionView, type Page } from './views.ts'
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

/**
 * From `au_root`, the root of revision `r`, joins `au`: the first entity (by
 * key) the root is authored by.
 */
const AUTHOR_JOINS = `
  JOIN revision_entities au_ref ON au_ref.revision_id = r.id
    AND au_ref.entity_key = (
      SELECT min(edge.target_key) FROM entity_relations edge
      WHERE edge.revision_id = r.id AND edge.source_key = au_root.entity_key
        AND edge.kind = '${AUTHORED_BY}')
  JOIN entity_versions au_version ON au_version.id = au_ref.entity_version_id
  JOIN entities au ON au.id = au_version.entity_id`

/** Revision `r` is rooted at an entity of one of these types. */
const rootTypeSQL = (types: string[]) => sql`EXISTS (
  SELECT 1 FROM revision_entities re
  JOIN entity_versions ev ON ev.id = re.entity_version_id
  JOIN entities en ON en.id = ev.entity_id
  WHERE re.revision_id = r.id AND re.is_root = 1
    AND en.kind IN (SELECT value FROM json_each(${list(types)})))`

/**
 * `subject` is an entity of revision `r` that is its root's own author, or
 * the root itself when it has no author (a profile is its own author).
 */
const IS_SUBJECT = `subject.revision_id = r.id AND (
  (subject.is_root = 1 AND NOT EXISTS (
    SELECT 1 FROM entity_relations edge
    JOIN revision_entities root ON root.revision_id = edge.revision_id
      AND root.entity_key = edge.source_key AND root.is_root = 1
    WHERE edge.revision_id = r.id AND edge.kind = '${AUTHORED_BY}'))
  OR EXISTS (
    SELECT 1 FROM entity_relations edge
    JOIN revision_entities root ON root.revision_id = edge.revision_id
      AND root.entity_key = edge.source_key AND root.is_root = 1
    WHERE edge.revision_id = r.id AND edge.target_key = subject.entity_key
      AND edge.kind = '${AUTHORED_BY}'))`

/**
 * Whether the author's account is protected, by the author's newest
 * complete version (captured as a root or a root's own author, at a head),
 * falling back to the snapshot. Unknown never counts as public.
 */
const visibilitySQL = (visibility: string) => sql`EXISTS (
  SELECT 1 FROM revision_entities subject
  JOIN entity_versions snapshot ON snapshot.id = subject.entity_version_id
  WHERE ${sql.raw(IS_SUBJECT)} AND json_type(coalesce((
    SELECT ev.data FROM entity_versions ev
    JOIN revision_entities re ON re.entity_version_id = ev.id
    JOIN revisions rv ON rv.id = re.revision_id
    WHERE ev.entity_id = snapshot.entity_id
      AND rv.id = ${sql.raw(head('rv.collection_id'))}
      AND (re.is_root = 1 OR EXISTS (
        SELECT 1 FROM entity_relations edge
        JOIN revision_entities root ON root.revision_id = edge.revision_id
          AND root.entity_key = edge.source_key AND root.is_root = 1
        WHERE edge.revision_id = re.revision_id
          AND edge.target_key = re.entity_key AND edge.kind = ${AUTHORED_BY}))
    ORDER BY rv.created_at DESC, rv.id DESC LIMIT 1), snapshot.data),
    '$.metadata.protected') = ${visibility === 'private' ? 'true' : 'false'})`

const contentMedia = (extra = '') => `EXISTS (
  SELECT 1 FROM assets m ${extra.includes('b.') ? 'JOIN blobs b ON b.id = m.blob_id' : ''}
  WHERE m.capture_id = r.capture_id AND m.purpose = '' ${extra})`

function mediaSQL(kinds: string[]): SQL {
  const any: string[] = []
  if (kinds.includes('text')) any.push(`NOT ${contentMedia()}`)
  if (kinds.includes('image'))
    any.push(contentMedia(`AND b.mime LIKE 'image/%'`))
  if (kinds.includes('video'))
    any.push(contentMedia(`AND b.mime LIKE 'video/%'`))
  return sql.raw(`(${any.join(' OR ')})`)
}

/**
 * Tagged directly, or written by an author whose saved collection is
 * tagged.
 */
const tagSQL = (tag: string) => sql`EXISTS (
  SELECT 1 FROM collection_tags ct
  WHERE ct.tag_id = ${tag} AND (ct.collection_id = a.id OR EXISTS (
    SELECT 1 FROM entity_relations edge
    JOIN revision_entities post_root ON post_root.revision_id = edge.revision_id
      AND post_root.entity_key = edge.source_key AND post_root.is_root = 1
    JOIN revision_entities author_ref ON author_ref.revision_id = edge.revision_id
      AND author_ref.entity_key = edge.target_key
    JOIN entity_versions author_version ON author_version.id = author_ref.entity_version_id
    JOIN revision_entities tagged_root
      ON tagged_root.revision_id = ${sql.raw(head('ct.collection_id'))}
      AND tagged_root.is_root = 1
    JOIN entity_versions tagged_version ON tagged_version.id = tagged_root.entity_version_id
      AND tagged_version.entity_id = author_version.entity_id
    WHERE edge.revision_id = r.id AND edge.kind = ${AUTHORED_BY})))`

/**
 * Collections directly related to the requested one, with how: either the
 * candidate's head root points at the requested identity (also by its
 * aliases), or the requested collection's root (in any revision) points at
 * the candidate's identity. A provisional target identity resolves through
 * the candidate's aliases. Context further away (a quoted post's author, an
 * author's bio) never relates.
 */
const relatedEdgesSQL = (requested: string) => sql`
  requested_roots AS (
    SELECT identity.platform, identity.kind, identity.external_id
    FROM library rl
    JOIN revision_entities target
      ON target.revision_id = ${sql.raw(head('rl.collection_id'))} AND target.is_root = 1
    JOIN entity_versions tv ON tv.id = target.entity_version_id
    JOIN entities identity ON identity.id = tv.entity_id
    WHERE rl.collection_id = ${requested}
    UNION
    SELECT identity.platform, identity.kind, alias.external_id
    FROM library rl
    JOIN collections rc ON rc.id = rl.collection_id
    JOIN revision_entities target
      ON target.revision_id = ${sql.raw(head('rc.id'))} AND target.is_root = 1
    JOIN entity_versions tv ON tv.id = target.entity_version_id
    JOIN entities identity ON identity.id = tv.entity_id
    JOIN collection_identity_aliases alias ON alias.collection_id = rc.id
      AND alias.platform = rc.platform AND alias.kind = rc.kind
      AND alias.object_scope = rc.object_scope
    WHERE rl.collection_id = ${requested}
  ),
  requested_targets AS (
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
  related_edges AS (
    SELECT rv.collection_id, relation.kind
    FROM requested_roots
    JOIN entities related_identity ON related_identity.platform = requested_roots.platform
      AND related_identity.kind = requested_roots.kind
      AND related_identity.external_id = requested_roots.external_id
    JOIN entity_versions related_version ON related_version.entity_id = related_identity.id
    JOIN revision_entities related ON related.entity_version_id = related_version.id
    JOIN entity_relations relation ON relation.revision_id = related.revision_id
      AND relation.target_key = related.entity_key
    JOIN revision_entities candidate_root ON candidate_root.revision_id = relation.revision_id
      AND candidate_root.entity_key = relation.source_key AND candidate_root.is_root = 1
    JOIN revisions rv ON rv.id = relation.revision_id
    WHERE rv.id = ${sql.raw(head('rv.collection_id'))}
    UNION ALL
    SELECT rv.collection_id, requested_targets.relation_kind
    FROM requested_targets
    JOIN entities candidate_identity ON candidate_identity.platform = requested_targets.platform
      AND candidate_identity.kind = requested_targets.kind
      AND candidate_identity.external_id = requested_targets.external_id
    JOIN entity_versions candidate_version ON candidate_version.entity_id = candidate_identity.id
    JOIN revision_entities candidate_root ON candidate_root.entity_version_id = candidate_version.id
      AND candidate_root.is_root = 1
    JOIN revisions rv ON rv.id = candidate_root.revision_id
    WHERE rv.id = ${sql.raw(head('rv.collection_id'))}
    UNION ALL
    SELECT candidate.id, requested_targets.relation_kind
    FROM requested_targets
    JOIN collection_identity_aliases alias ON alias.external_id = requested_targets.external_id
    JOIN collections candidate ON candidate.id = alias.collection_id
      AND candidate.platform = alias.platform AND candidate.kind = alias.kind
      AND candidate.object_scope = alias.object_scope
    JOIN revision_entities candidate_root
      ON candidate_root.revision_id = ${sql.raw(head('candidate.id'))}
      AND candidate_root.is_root = 1
    JOIN entity_versions candidate_version ON candidate_version.id = candidate_root.entity_version_id
    JOIN entities candidate_identity ON candidate_identity.id = candidate_version.entity_id
      AND candidate_identity.platform = requested_targets.platform
      AND candidate_identity.kind = requested_targets.kind
  )`

const relatedSQL = (requested: string) =>
  sql`a.id <> ${requested} AND EXISTS (SELECT 1 FROM related_edges e WHERE e.collection_id = a.id)`

/**
 * Repost is relative to the requested collection when there is one;
 * otherwise any saved repost edge into the root makes it one. A quote has
 * its own text plus an outgoing quoted edge.
 */
const postTypeSQL = (related: boolean) => sql`CASE
  WHEN ${
    related
      ? sql`EXISTS (SELECT 1 FROM related_edges e WHERE e.collection_id = a.id AND e.kind = 'reposted')`
      : sql`EXISTS (
          SELECT 1 FROM revision_entities root
          JOIN entity_versions rootv ON rootv.id = root.entity_version_id
          JOIN entity_versions version ON version.entity_id = rootv.entity_id
          JOIN revision_entities target ON target.entity_version_id = version.id
          JOIN entity_relations edge ON edge.revision_id = target.revision_id
            AND edge.target_key = target.entity_key AND edge.kind = 'reposted'
          JOIN revisions owner ON owner.id = edge.revision_id
          JOIN library saved ON saved.collection_id = owner.collection_id
          WHERE root.revision_id = r.id AND root.is_root = 1)`
  } THEN 'repost'
  WHEN EXISTS (
    SELECT 1 FROM entity_relations edge
    JOIN revision_entities root ON root.revision_id = edge.revision_id
      AND root.entity_key = edge.source_key AND root.is_root = 1
    WHERE edge.revision_id = r.id AND edge.kind = 'quoted') THEN 'quote'
  ELSE 'post' END`

// Publication time when the payload has a valid one, else capture time.
const PUBLISHED_AT = `CASE WHEN r.payload ->> 'published_at' GLOB '[0-9][0-9][0-9][0-9]-*'
  THEN CAST(round(unixepoch(r.payload ->> 'published_at', 'subsec') * 1000) AS INTEGER) END`

/** Saved collections with a revision; `r` is the head revision. */
const SAVED_HEADS = `library l
  JOIN collections a ON a.id = l.collection_id
  JOIN revisions r ON r.id = ${head('a.id')}`

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
      sql`concat_ws(' ', r.payload ->> 'text', r.payload ->> 'summary', r.payload ->> 'author_name') LIKE ${`%${q.replaceAll(/[\\%_]/g, String.raw`\$&`)}%`} ESCAPE '\\'`,
    )
  if (filter.visibility) conditions.push(visibilitySQL(filter.visibility))
  if (from !== undefined) conditions.push(sql`l.created_at >= ${from}`)
  if (before !== undefined) conditions.push(sql`l.created_at < ${before}`)
  if (filter.mediaType) conditions.push(mediaSQL(values(filter.mediaType)))
  if (types.length) conditions.push(rootTypeSQL(types))
  if (authors.length)
    conditions.push(
      sql`EXISTS (SELECT 1 FROM revision_entities au_root ${sql.raw(AUTHOR_JOINS)}
        WHERE au_root.revision_id = r.id AND au_root.is_root = 1
          AND (au.platform, au.kind, au.external_id) IN (
          SELECT value ->> 0, value ->> 1, value ->> 2
          FROM json_each(${list(authors.map((a) => [a.platform, a.kind, a.external]))})))`,
    )
  if (filter.sensitive)
    conditions.push(
      sql`${sql.raw(contentMedia('AND m.sensitive = 1'))} = ${filter.sensitive === 'contains' ? 1 : 0}`,
    )
  if (filter.tag) conditions.push(tagSQL(filter.tag))
  if (related) conditions.push(relatedSQL(related))
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
      SELECT a.id,
        ${sql.raw(filter.sort === 'published' ? `coalesce(${PUBLISHED_AT}, a.observed_at)` : 'a.observed_at')} AS at,
        ${sql.raw(storageOf('a.id'))} AS bytes,
        ${
          related
            ? sql.raw(`(SELECT json_group_array(kind) FROM (
                SELECT DISTINCT e.kind FROM related_edges e
                WHERE e.collection_id = a.id ORDER BY e.kind))`)
            : sql`NULL`
        } AS relations
      FROM ${sql.raw(SAVED_HEADS)}
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
        SELECT coalesce(sum(${sql.raw(storageOf('a.id'))}), 0) AS bytes
        FROM ${sql.raw(SAVED_HEADS)}
        WHERE ${relatedSQL(related)}
          ${types.length ? sql`AND ${rootTypeSQL(types)}` : sql``}`)?.bytes ?? 0
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
      ? (JSON.parse(entry.relations) as string[])
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
  const rows = ctx.db.all<{
    platform: string
    kind: string
    external: string
    name: string
    at: number
    revision: string
  }>(sql`
    SELECT au.platform, au.kind, au.external_id AS external,
      trim(coalesce(r.payload ->> 'author_name', '')) AS name,
      r.created_at AS at, r.id AS revision
    FROM ${sql.raw(SAVED_HEADS)}
    JOIN revision_entities au_root ON au_root.revision_id = r.id AND au_root.is_root = 1
    ${sql.raw(AUTHOR_JOINS)}`)
  // Prefer a captured name, then the newest.
  rows.sort(
    (a, b) =>
      Number(!a.name) - Number(!b.name) ||
      b.at - a.at ||
      byteOrder(b.revision, a.revision),
  )
  const authors = new Map<string, Author>()
  for (const row of rows) {
    const id = authorKey(row)
    // Without a captured name the platform's own id is the only honest
    // label; merging blank names would merge authors.
    if (!authors.has(id))
      authors.set(id, { id, name: row.name || row.external })
  }
  return [...authors.values()].toSorted(
    (a, b) => byteOrder(a.name, b.name) || byteOrder(a.id, b.id),
  )
}
