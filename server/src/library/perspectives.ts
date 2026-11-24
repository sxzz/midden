import { sql } from 'drizzle-orm'
import { AppError } from '#errors.ts'
import { authorKey, parseAuthorKey } from './list.ts'
import { iso, type Page, type Reader } from './views.ts'

/**
 * How far one list (关注 or 粉丝) of an account was read: the newest complete
 * fetch, or failing that the newest partial one. Neither means it was never
 * read, and what is known of it comes from other accounts' lists.
 */
export interface ListFetch {
  complete_at?: string
  partial_at?: string
}

/** An account the 「关系」 filter can look from. */
export interface Perspective {
  /** The account key, as `rel_of` takes it. */
  id: string
  name?: string
  username?: string
  /** One of the owner's capture accounts. */
  own?: true
  following: ListFetch
  followers: ListFetch
}

export interface PerspectiveFilter {
  /** Part of the name, the username or the platform's id, any case. */
  q?: string
  cursor?: string
  /** Only this account key, unpaged: the label of a chosen one. */
  relOf?: string
}

const PAGE = 50
const MAX_QUERY = 500

/**
 * Accounts with relation data: in a stored follow either way, or with a
 * fetch of one of their lists. Read from the follow indexes, which lead
 * with each side's id.
 */
const WITH_DATA = sql`
  SELECT follower_id AS id FROM follow_edges
  UNION SELECT followee_id FROM follow_edges
  UNION SELECT entity_id FROM relation_fetches WHERE entity_id IS NOT NULL`

/** The accounts the owner captures with, by their platform's account id. */
const OWN = sql`
  SELECT e.id FROM connections c
  JOIN entities e ON e.platform = c.adapter_id
    AND e.kind = c.adapter_id || '.profile' AND e.external_id = c.account_id
  WHERE c.state <> 'revoked' AND c.account_id <> ''`

/**
 * The data an account's name and username come from: its saved profile's
 * own, else the newest stored anywhere. A post's author is often stored
 * with less, so the newest alone may have no name.
 */
const NEWEST = (column: string) =>
  sql.raw(`coalesce((SELECT v.data FROM catalog k
      JOIN revision_entities re ON re.revision_id = k.revision_id
        AND re.is_root = 1
      JOIN entity_versions v ON v.id = re.entity_version_id
      WHERE k.root_entity_id = ${column} LIMIT 1),
    (SELECT v.data FROM entity_versions v WHERE v.entity_id = ${column}
      ORDER BY v.created_at DESC, v.id DESC LIMIT 1))`)

const ORDER = sql.raw(
  'own DESC, fetched_at IS NULL, fetched_at DESC, edges DESC, label, id',
)

const fetchedAt = (list: string, state: string) =>
  sql.raw(`(SELECT max(f.finished_at) FROM relation_fetches f
    WHERE f.entity_id = page.id AND f.list = '${list}'
      AND f.state = '${state}')`)

function listFetch(complete: number | null, partial: number | null) {
  if (complete === null)
    return partial === null ? {} : { partial_at: iso(partial) }
  return { complete_at: iso(complete) }
}

/**
 * Accounts with relation data, 50 a page: the owner's capture accounts
 * first, then those whose lists were fetched (newest first), then the rest
 * by how many current follows involve them. Each says how far its lists
 * were read, for the filter's note on how complete it is.
 */
export function listPerspectives(
  r: Reader,
  input: PerspectiveFilter = {},
): Page<Perspective> {
  const q = (input.q ?? '').trim().toLocaleLowerCase()
  const offset = input.cursor ? Number(input.cursor) : 0
  const wanted = input.relOf ? parseAuthorKey(input.relOf) : undefined
  if (
    [...q].length > MAX_QUERY ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    (input.cursor && String(offset) !== input.cursor) ||
    (input.relOf && !wanted)
  )
    throw new AppError('invalid_filter')
  const like = `%${q.replaceAll(/[\\%_]/g, String.raw`\$&`)}%`
  // A chosen account is labelled even when its data is gone, so the
  // filter still reads by name.
  const candidates = wanted
    ? sql`SELECT id FROM entities WHERE platform = ${wanted.platform}
        AND kind = ${wanted.kind} AND external_id = ${wanted.external}`
    : WITH_DATA
  const rows = r.db.all<{
    platform: string
    kind: string
    external: string
    name: string | null
    username: string | null
    own: number
    following_complete: number | null
    following_partial: number | null
    followers_complete: number | null
    followers_partial: number | null
  }>(sql`
    WITH accounts AS MATERIALIZED (
      SELECT e.id, e.platform, e.kind, e.external_id,
        ${NEWEST('e.id')} AS data
      FROM (${candidates}) c JOIN entities e ON e.id = c.id
      WHERE e.kind LIKE '%.profile'
    ),
    named AS (
      SELECT id, platform, kind, external_id,
        nullif(data ->> '$.name', '') AS name,
        nullif(data ->> '$.username', '') AS username
      FROM accounts
    ),
    fetched AS (
      SELECT entity_id AS id, max(coalesce(finished_at, created_at)) AS at
      FROM relation_fetches WHERE entity_id IS NOT NULL GROUP BY entity_id
    ),
    ranked AS (
      SELECT named.*, named.id IN (${OWN}) AS own, fetched.at AS fetched_at,
        (SELECT count(*) FROM follow_edges f
          WHERE f.follower_id = named.id AND f.ended_at IS NULL)
        + (SELECT count(*) FROM follow_edges f
          WHERE f.followee_id = named.id AND f.ended_at IS NULL) AS edges,
        coalesce(name, username, external_id) AS label
      FROM named LEFT JOIN fetched ON fetched.id = named.id
      WHERE ${
        q && !wanted
          ? sql`(lower(name) LIKE ${like} ESCAPE '\\'
              OR lower(username) LIKE ${like} ESCAPE '\\'
              OR lower(external_id) LIKE ${like} ESCAPE '\\')`
          : sql`1 = 1`
      }
    ),
    page AS (
      SELECT * FROM ranked ORDER BY ${ORDER}
      LIMIT ${PAGE + 1} OFFSET ${offset}
    )
    SELECT platform, kind, external_id AS external, name, username, own,
      ${fetchedAt('following', 'complete')} AS following_complete,
      ${fetchedAt('following', 'partial')} AS following_partial,
      ${fetchedAt('followers', 'complete')} AS followers_complete,
      ${fetchedAt('followers', 'partial')} AS followers_partial
    FROM page ORDER BY ${ORDER}`)
  const page: Page<Perspective> = {
    items: rows.slice(0, PAGE).map((row) => ({
      id: authorKey(row),
      ...(row.name ? { name: row.name } : {}),
      ...(row.username ? { username: row.username } : {}),
      ...(row.own ? { own: true as const } : {}),
      following: listFetch(row.following_complete, row.following_partial),
      followers: listFetch(row.followers_complete, row.followers_partial),
    })),
  }
  if (rows.length > PAGE) page.next_cursor = String(offset + PAGE)
  return page
}
