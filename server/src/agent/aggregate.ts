// `GET /agent/v1/aggregate`: how what a query selects falls into buckets
// (by author, time, type, tag, hashtag…), each with its count, the first
// and last publication times and a few sample ids, so an agent can see the
// shape of a set before reading any of it. Runs on a read thread in the
// agent lane like every read, with its timeout.
import { sql, type SQL } from 'drizzle-orm'
import { authorKey, postTypeSQL, wholeSelection } from '#library/list.ts'
import { list } from '#library/views.ts'
import { parseQuery, usesKey, type QueryNode } from '#query/ast.ts'
import { compileQuery } from '#query/compile.ts'
import { printQuery } from '#query/print.ts'
import { describeQuery } from '#reads/slow.ts'
import { invalid } from './errors.ts'
import { checkKeys, type AgentReader, type Params } from './query.ts'

export const AGGREGATE_BY = [
  'author',
  'day',
  'week',
  'month',
  'hour',
  'weekday',
  'type',
  'media',
  'tag',
  'hashtag',
  'mention',
  'domain',
  'lang',
  'platform',
] as const

export type AggregateBy = (typeof AGGREGATE_BY)[number]

const TIME: Set<AggregateBy> = new Set([
  'day',
  'week',
  'month',
  'hour',
  'weekday',
])
/** Buckets with an order of their own, rather than by count. */
const CHRONOLOGICAL: Set<AggregateBy> = new Set(['day', 'week', 'month'])
const CYCLIC: Set<AggregateBy> = new Set(['hour', 'weekday'])

export const AGGREGATE_LIMIT = 100
export const AGGREGATE_LIMIT_MAX = 1000
const SAMPLES = 3
const LIMIT = /^\d{1,4}$/

interface Bucket {
  key: string | number | null
  count: number
  first: string
  last: string
  samples: string[]
  [label: string]: unknown
}

/**
 * Milliseconds to add to a UTC time for the zone's local time, as SQL over
 * `at`: one offset, or one per stretch between the zone's transitions over
 * the archive's publication times.
 */
function offsetSQL(r: AgentReader, zone: string): SQL {
  const span = r.db.get<{ min: number | null; max: number | null }>(
    sql`SELECT min(published_at) AS min, max(published_at) AS max FROM catalog`,
  )
  if (span?.min == null || span.max == null) return sql`0`
  const offset = (ms: number) =>
    Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(zone)
      .offsetNanoseconds / 1e6
  const stretches: { until: number; offset: number }[] = []
  let at = Temporal.Instant.fromEpochMilliseconds(span.min).toZonedDateTimeISO(
    zone,
  )
  while (stretches.length < 500) {
    const next = at.getTimeZoneTransition('next')
    if (!next || next.epochMilliseconds > span.max) break
    stretches.push({
      until: next.epochMilliseconds,
      offset: offset(at.epochMilliseconds),
    })
    at = next
  }
  const last = offset(at.epochMilliseconds)
  if (!stretches.length) return sql`(${last} + 0)`
  return sql`(CASE ${sql.join(
    stretches.map((s) => sql`WHEN m.at < ${s.until} THEN ${s.offset}`),
    sql` `,
  )} ELSE ${last} END)`
}

/** `type:post` before a query (or alone): what an untyped one counts. */
function impliedPosts(node: QueryNode | undefined): QueryNode {
  const posts: QueryNode = {
    type: 'atom',
    key: 'type',
    value: 'post',
    start: 0,
    end: 0,
  }
  if (!node) return posts
  return {
    type: 'and',
    items: [posts, ...(node.type === 'and' ? node.items : [node])],
    start: 0,
    end: 0,
  }
}

/** A time zone Temporal knows, or undefined. */
function zoneOf(raw: string): string | undefined {
  if (raw.length > 64) return undefined
  try {
    return Temporal.Now.zonedDateTimeISO(raw).timeZoneId
  } catch {
    return undefined
  }
}

const one = (params: Params, key: string) => {
  const raw = params[key] ?? []
  if (raw.length > 1) throw invalid(`${key} is given more than once.`)
  return raw[0]?.trim() || undefined
}

export function aggregate(r: AgentReader, input: { params: Params }) {
  const { params } = input
  checkKeys(params, ['q', 'by', 'tz', 'limit'])
  const by = one(params, 'by') as AggregateBy | undefined
  if (!by || !AGGREGATE_BY.includes(by))
    throw invalid(`by must be one of: ${AGGREGATE_BY.join(', ')}.`)
  const tz = one(params, 'tz') ?? 'UTC'
  const zone = zoneOf(tz)
  if (!zone) throw invalid(`tz must be an IANA time zone, as Asia/Tokyo.`)
  const rawLimit = one(params, 'limit')
  const limit = rawLimit === undefined ? AGGREGATE_LIMIT : Number(rawLimit)
  if (!LIMIT.test(rawLimit ?? '1') || limit < 1 || limit > AGGREGATE_LIMIT_MAX)
    throw invalid(
      `limit must be a whole number from 1 to ${AGGREGATE_LIMIT_MAX}.`,
    )
  const q = one(params, 'q')
  // Posts unless the query says otherwise (`type:profile`, or both).
  const node = q ? parseQuery(q) : undefined
  const typed = !!node && usesKey(node, 'type')
  const scope = typed ? {} : { entityType: r.types.posts.join(',') }
  const compiled = q
    ? compileQuery(q, {
        db: r.db,
        types: r.types,
        kind: 'all',
        filter: scope,
        timeZone: zone,
      })
    : undefined
  const parsed = typed ? compiled!.parsed : printQuery(impliedPosts(node))
  describeQuery(JSON.stringify({ q: parsed, by, tz: zone, limit }))
  const base = compiled?.folder
    ? compiled.folder.filter
    : (compiled?.filter ?? scope)
  const narrow = compiled?.folder ? compiled.filter : undefined
  const selection = wholeSelection(r.db, base, narrow, compiled?.extra)
  const local = sql`(m.at + ${TIME.has(by) ? offsetSQL(r, zone) : sql`0`}) / 1000`
  // What each matched item counts under: one key, or several (tags…).
  const keyed: SQL = (() => {
    const row = (key: SQL) =>
      sql`SELECT ${key} AS key, m.id, m.at FROM matched m`
    switch (by) {
      case 'author':
        return sql`SELECT m.subject AS key, m.id, m.at FROM matched m
          WHERE m.subject IS NOT NULL`
      case 'day':
        return row(sql`strftime('%Y-%m-%d', ${local}, 'unixepoch')`)
      case 'week':
        return row(sql`date(${local}, 'unixepoch', '-6 days', 'weekday 1')`)
      case 'month':
        return row(sql`strftime('%Y-%m', ${local}, 'unixepoch')`)
      case 'hour':
        return row(sql`CAST(strftime('%H', ${local}, 'unixepoch') AS INTEGER)`)
      case 'weekday':
        // ISO: 1 is Monday, 7 Sunday.
        return row(
          sql`(CAST(strftime('%w', ${local}, 'unixepoch') AS INTEGER) + 6) % 7 + 1`,
        )
      case 'type':
      case 'media':
      case 'lang':
      case 'platform':
        return row(sql`m.facet`)
      case 'tag':
        // A tag on the author's account counts for its posts, as `tag:`
        // selects them.
        return sql`SELECT ct.tag_id AS key, m.id, m.at FROM matched m
          JOIN collection_tags ct ON ct.collection_id = m.id
          UNION
          SELECT ct.tag_id, m.id, m.at FROM matched m
          JOIN catalog tagged ON tagged.root_entity_id = m.author
          JOIN collection_tags ct ON ct.collection_id = tagged.collection_id`
      case 'hashtag':
      case 'mention':
      case 'domain':
        return sql`SELECT f.value AS key, m.id, m.at FROM matched m
          JOIN ${sql.identifier(`post_${by}s`)} f ON f.catalog_id = m.cid`
    }
  })()
  const facet = (() => {
    switch (by) {
      case 'type':
        // `post` is named `original` below, as `is:` names it.
        return sql`CASE WHEN k.root_kind LIKE '%.profile' THEN 'profile'
          ELSE ${postTypeSQL(false)} END`
      case 'media':
        return sql`CASE WHEN k.has_image AND k.has_video THEN 'image+video'
          WHEN k.has_video THEN 'video' WHEN k.has_image THEN 'image'
          WHEN k.has_media THEN 'other' ELSE 'none' END`
      case 'lang':
        return sql`coalesce(k.lang, 'und')`
      case 'platform':
        return sql`substr(k.root_kind, 1, instr(k.root_kind, '.') - 1)`
      default:
        return sql`NULL`
    }
  })()
  const order = CHRONOLOGICAL.has(by)
    ? sql`key DESC`
    : CYCLIC.has(by)
      ? sql`key`
      : sql`n DESC, key`
  const rows = r.db.all<{
    key: string | number | null
    n: number
    first: number
    last: number
    samples: string
    buckets: number
    total: number
  }>(sql`
    WITH ${sql.join(
      [
        ...selection.items,
        sql`matched AS MATERIALIZED (
          SELECT k.id AS cid, k.collection_id AS id, k.published_at AS at,
            k.subject_entity_id AS subject, k.author_entity_id AS author,
            ${facet} AS facet
          FROM ${sql.raw(selection.source)} WHERE ${selection.where})`,
        sql`keyed AS MATERIALIZED (${keyed})`,
        sql`grouped AS MATERIALIZED (
          SELECT key, count(*) AS n, min(at) AS first, max(at) AS last
          FROM keyed GROUP BY key)`,
        sql`top AS MATERIALIZED (
          SELECT * FROM grouped ORDER BY ${order} LIMIT ${limit})`,
        sql`sampled AS (
          SELECT key, id FROM (
            SELECT keyed.key, keyed.id, row_number() OVER (
              PARTITION BY keyed.key ORDER BY keyed.at DESC, keyed.id DESC) AS r
            FROM keyed WHERE keyed.key IN (SELECT key FROM top))
          WHERE r <= ${SAMPLES})`,
      ],
      sql`, `,
    )}
    SELECT t.key, t.n, t.first, t.last,
      (SELECT json_group_array(s.id) FROM sampled s WHERE s.key = t.key) AS samples,
      (SELECT count(*) FROM grouped) AS buckets,
      (SELECT count(*) FROM matched) AS total
    FROM top t ORDER BY ${order}`)
  const total =
    rows[0]?.total ??
    r.db.get<{ n: number }>(sql`
      ${selection.ctes} SELECT count(*) AS n FROM ${sql.raw(selection.source)}
      WHERE ${selection.where}`)?.n ??
    0
  const labels = labelsOf(
    r,
    by,
    rows.map((row) => row.key),
  )
  const iso = (ms: number) => new Date(ms).toISOString()
  const buckets: Bucket[] = rows.map((row) => ({
    ...(labels.get(row.key) ?? {
      key: by === 'type' && row.key === 'post' ? 'original' : row.key,
    }),
    count: row.n,
    first: iso(row.first),
    last: iso(row.last),
    samples: JSON.parse(row.samples) as string[],
  }))
  return {
    parsed,
    by,
    ...(TIME.has(by) ? { tz: zone } : {}),
    total,
    buckets,
    truncated: (rows[0]?.buckets ?? 0) > rows.length,
  }
}

/** Keys that are ids, as something to read: accounts and tags. */
function labelsOf(
  r: AgentReader,
  by: AggregateBy,
  keys: (string | number | null)[],
): Map<string | number | null, { key: string | number | null }> {
  const out = new Map<string | number | null, { key: string | number | null }>()
  if (by === 'author' && keys.length)
    for (const row of r.db.all<{
      id: string
      platform: string
      kind: string
      external: string
      handle: string | null
      name: string | null
    }>(sql`
      SELECT e.id, e.platform, e.kind, e.external_id AS external,
        v.data ->> 'username' AS handle, v.data ->> 'name' AS name
      FROM json_each(${list(keys)}) w
      JOIN entities e ON e.id = w.value
      LEFT JOIN entity_versions v ON v.id = (
        SELECT id FROM entity_versions WHERE entity_id = e.id
        ORDER BY created_at DESC, id DESC LIMIT 1)`))
      out.set(row.id, {
        key: authorKey(row),
        ...(row.handle ? { handle: row.handle } : {}),
        ...(row.name ? { name: row.name } : {}),
      })
  if (by === 'tag' && keys.length)
    for (const row of r.db.all<{ id: string; name: string }>(sql`
      SELECT id, name FROM tags
      WHERE id IN (SELECT value FROM json_each(${list(keys)}))`))
      out.set(row.id, { key: row.name, id: row.id } as { key: string })
  return out
}
