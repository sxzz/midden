import { sql } from 'drizzle-orm'
import { subjectOf } from './follows.ts'
import { authorKey } from './list.ts'
import {
  assetsById,
  avatarOf,
  iso,
  list,
  parseJson,
  type AssetView,
  type Reader,
} from './views.ts'
import type { CaptureContext } from '#capture/context.ts'

/**
 * How an account relates to the center now: it follows the center back
 * (`mutual`), only the center follows it (`following`), or only it follows
 * the center (`followers`). Every account has exactly one.
 */
export const graphKinds = ['following', 'followers', 'mutual'] as const
export type GraphKind = (typeof graphKinds)[number]

export interface GraphNode {
  entity_id: string
  /** The account key, as `rel_of` takes it. */
  key: string
  external_id: string
  name?: string
  username?: string
  avatar?: AssetView
  /** The profile's own counts, as its newest capture read them. */
  followers?: number
  following?: number
  /** The account's saved profile. */
  collection_id?: string
  /** Absent on the center. */
  kind?: GraphKind
}

/** When a list of the center was last read, completely or in part. */
export interface GraphList {
  /** The newest complete fetch. */
  complete_at?: string
  /** The newest partial fetch after it. */
  partial_at?: string
}

export interface FollowGraph {
  /** The center first, then accounts by follower count, most first. */
  nodes: GraphNode[]
  /**
   * Current follows among the nodes, `[follower, followee]` as indexes into
   * `nodes`: the center's own and those among the others.
   */
  edges: [number, number][]
  /** Accounts of the chosen kinds, beyond the ones returned. */
  total: number
  /** Accounts of each kind, whichever were chosen. */
  kinds: Record<GraphKind, number>
  lists: { following: GraphList; followers: GraphList }
}

export interface GraphQuery {
  kinds?: readonly GraphKind[]
  limit?: number
}

export const GRAPH_LIMIT = 300
export const GRAPH_MAX = 10_000

/**
 * Where a capture's metrics keep a profile's own counts, as SQLite JSON
 * path suffixes: metrics are keyed by entity, then by the pointer the
 * platform declares for each list's size. Follows only join accounts of one
 * platform, so the center's platform tells.
 */
export function countPaths(
  ctx: Pick<CaptureContext, 'platforms'>,
  platform: string,
) {
  const counts = ctx.platforms
    .all()
    .find((p) => p.description.adapterId === platform)?.relations?.counts
  return (
    counts && {
      followers: `."${counts.followers}"`,
      following: `."${counts.following}"`,
    }
  )
}

interface Ranked {
  id: string
  kind: GraphKind | null
  platform: string
  entity_kind: string
  external_id: string
  collection_id: string | null
  followers: number | null
  following: number | null
}

/**
 * The center and every account it follows or is followed by now, with the
 * counts each one's newest capture read. One pass over the center's open
 * follows by the follower and followee indexes, then a look-up per account.
 */
function rankable(
  r: Reader,
  subject: string,
  paths: { followers: string; following: string } | undefined,
): Ranked[] {
  const count = (path: string | undefined) =>
    path
      ? sql`json_extract(cp.metrics,
          '$."' || e.kind || '/' || e.external_id || '"' || ${path})`
      : sql`NULL`
  return r.db.all<Ranked>(sql`
    WITH rel AS (
      SELECT other, max(o) AS o, max(i) AS i FROM (
        SELECT followee_id AS other, 1 AS o, 0 AS i FROM follow_edges
        WHERE follower_id = ${subject} AND ended_at IS NULL
        UNION ALL
        SELECT follower_id, 0, 1 FROM follow_edges
        WHERE followee_id = ${subject} AND ended_at IS NULL)
      WHERE other <> ${subject}
      GROUP BY other
      UNION ALL
      SELECT ${subject}, NULL, NULL
    ),
    accounts AS (
      SELECT rel.other AS id,
        CASE WHEN o IS NULL THEN NULL WHEN o AND i THEN 'mutual'
          WHEN o THEN 'following' ELSE 'followers' END AS kind,
        e.external_id, c.id AS collection_id,
        (SELECT cp.id FROM captures cp
          WHERE cp.collection_id = c.id AND cp.metrics IS NOT NULL
            AND cp.state IN ('complete', 'partial')
          ORDER BY cp.finished_at DESC, cp.id DESC LIMIT 1) AS capture_id
      FROM rel
      JOIN entities e ON e.id = rel.other
      LEFT JOIN collections c ON c.platform = e.platform
        AND c.kind = substr(e.kind, length(e.platform) + 2)
        AND c.object_scope = '' AND c.external_id = e.external_id
        AND EXISTS (SELECT 1 FROM library l WHERE l.collection_id = c.id)
    )
    SELECT a.id, a.kind, e.platform, e.kind AS entity_kind, a.external_id,
      a.collection_id,
      ${count(paths?.followers)} AS followers,
      ${count(paths?.following)} AS following
    FROM accounts a
    JOIN entities e ON e.id = a.id
    LEFT JOIN captures cp ON cp.id = a.capture_id`)
}

interface Shown {
  id: string
  data: string | null
  avatar: string | null
}

/** Names and avatars of the accounts shown, as their saved profiles read. */
export function shownAccounts(
  r: Reader,
  ids: readonly string[],
): Map<string, Shown> {
  const rows = r.db.all<Shown>(sql`
    SELECT e.id,
      coalesce(own.data, (SELECT v.data FROM entity_versions v
        WHERE v.entity_id = e.id ORDER BY v.created_at DESC, v.id DESC
        LIMIT 1)) AS data,
      ${sql.raw(avatarOf('rv', 're.entity_key'))} AS avatar
    FROM json_each(${list(ids)}) wanted
    JOIN entities e ON e.id = wanted.value
    LEFT JOIN collections c ON c.platform = e.platform
      AND c.kind = substr(e.kind, length(e.platform) + 2)
      AND c.object_scope = '' AND c.external_id = e.external_id
      AND EXISTS (SELECT 1 FROM library l WHERE l.collection_id = c.id)
    LEFT JOIN revisions rv ON rv.id = c.current_revision
    LEFT JOIN revision_entities re ON re.revision_id = rv.id AND re.is_root = 1
    LEFT JOIN entity_versions own ON own.id = re.entity_version_id
      AND own.entity_id = e.id`)
  return new Map(rows.map((row) => [row.id, row]))
}

/**
 * Current follows among these accounts: each one's open follows by the
 * follower index, kept when the followee is among them too. The ids are
 * materialized once; read as two `IN (json_each)` subqueries SQLite took
 * seconds for a few thousand accounts.
 */
export function edgesAmong(r: Reader, ids: readonly string[]) {
  return r.db.all<{ follower: string; followee: string }>(sql`
    WITH ids(id) AS MATERIALIZED (SELECT value FROM json_each(${list(ids)}))
    SELECT f.follower_id AS follower, f.followee_id AS followee
    FROM ids JOIN follow_edges f ON f.follower_id = ids.id
      AND f.ended_at IS NULL
    WHERE f.followee_id IN ids`)
}

export function listsOf(r: Reader, subject: string): FollowGraph['lists'] {
  const rows = r.db.all<{
    list: 'following' | 'followers'
    state: string
    at: number
  }>(sql`SELECT list, state, finished_at AS at FROM relation_fetches
    WHERE entity_id = ${subject} AND state IN ('complete', 'partial')
      AND finished_at IS NOT NULL
    ORDER BY finished_at`)
  const lists: FollowGraph['lists'] = { following: {}, followers: {} }
  for (const row of rows) {
    const found = lists[row.list]
    if (row.state === 'complete') {
      found.complete_at = iso(row.at)
      delete found.partial_at
    } else found.partial_at = iso(row.at)
  }
  return lists
}

/** An account's name, username and avatar, as far as they are known. */
export function accountLabel(
  account: Shown | undefined,
  avatars: Map<string, AssetView>,
): Pick<GraphNode, 'name' | 'username' | 'avatar'> {
  const data = account?.data
    ? parseJson<Record<string, unknown>>(account.data)
    : {}
  const avatar = account?.avatar ? avatars.get(account.avatar) : undefined
  return {
    ...(typeof data.name === 'string' && data.name ? { name: data.name } : {}),
    ...(typeof data.username === 'string' && data.username
      ? { username: data.username }
      : {}),
    ...(avatar ? { avatar } : {}),
  }
}

/** Avatars of these accounts, by asset id. */
export function avatarsOf(r: Reader, shown: Map<string, Shown>) {
  return assetsById(
    r,
    [...shown.values()].flatMap((row) => (row.avatar ? [row.avatar] : [])),
  )
}

const byFollowers = (a: Ranked, b: Ranked) =>
  (b.followers ?? -1) - (a.followers ?? -1) ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/**
 * The ego graph of a saved profile: the account, the accounts it follows
 * and that follow it now, ranked by their follower counts and cut at
 * `limit`, with the current follows among all of them so communities show.
 * Ended follows are left out. Without any follow it is the center alone;
 * for what is not a profile, nothing.
 */
export function followGraph(
  ctx: Reader & Pick<CaptureContext, 'platforms'>,
  id: string,
  query: GraphQuery = {},
): FollowGraph {
  const subject = subjectOf(ctx, id)
  const kinds = new Set(query.kinds ?? graphKinds)
  const limit = query.limit ?? GRAPH_LIMIT
  const empty = {
    nodes: [],
    edges: [],
    total: 0,
    kinds: { following: 0, followers: 0, mutual: 0 },
    lists: { following: {}, followers: {} },
  }
  if (!subject) return empty
  const platform = ctx.db.get<{ platform: string }>(
    sql`SELECT platform FROM entities WHERE id = ${subject}`,
  )!.platform
  const rows = rankable(ctx, subject, countPaths(ctx, platform))
  const center = rows.find((row) => row.id === subject)!
  const counts = { following: 0, followers: 0, mutual: 0 }
  const chosen: Ranked[] = []
  for (const row of rows) {
    if (!row.kind) continue
    counts[row.kind]++
    if (kinds.has(row.kind)) chosen.push(row)
  }
  chosen.sort(byFollowers)
  const kept = [center, ...chosen.slice(0, limit)]
  const shown = shownAccounts(
    ctx,
    kept.map((row) => row.id),
  )
  const avatars = avatarsOf(ctx, shown)
  const nodes = kept.map((row): GraphNode => ({
    entity_id: row.id,
    key: authorKey({
      platform: row.platform,
      kind: row.entity_kind,
      external: row.external_id,
    }),
    external_id: row.external_id,
    ...accountLabel(shown.get(row.id), avatars),
    ...(typeof row.followers === 'number' ? { followers: row.followers } : {}),
    ...(typeof row.following === 'number' ? { following: row.following } : {}),
    ...(row.collection_id ? { collection_id: row.collection_id } : {}),
    ...(row.kind ? { kind: row.kind } : {}),
  }))
  const index = new Map(kept.map((row, i) => [row.id, i]))
  const edges = edgesAmong(
    ctx,
    kept.map((row) => row.id),
  )
    .map((edge): [number, number] => [
      index.get(edge.follower)!,
      index.get(edge.followee)!,
    ])
    .toSorted((a, b) => a[0] - b[0] || a[1] - b[1])
  return {
    nodes,
    edges,
    total: chosen.length,
    kinds: counts,
    lists: listsOf(ctx, subject),
  }
}
