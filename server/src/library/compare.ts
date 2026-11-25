import { sql } from 'drizzle-orm'
import { AppError } from '#errors.ts'
import {
  accountLabel,
  avatarsOf,
  countPaths,
  edgesAmong,
  GRAPH_LIMIT,
  listsOf,
  shownAccounts,
  viewerRelations,
  type GraphList,
  type GraphNode,
  type GraphViewer,
} from './follow-graph.ts'
import { authorKey, defaultRelMin, parseAuthorKey } from './list.ts'
import { list, type Reader } from './views.ts'
import type { CaptureContext } from '#capture/context.ts'

/** Which side of the accounts compared: whom they follow, or who follows them. */
export const compareSides = ['following', 'followers'] as const
export type CompareSide = (typeof compareSides)[number]

/** One of the accounts compared, in the order asked. */
export interface CompareAccount extends Omit<GraphNode, 'kind' | 'entity_id'> {
  /** Absent for an account never stored. */
  entity_id?: string
  lists: { following: GraphList; followers: GraphList }
}

/** An account related to at least `min` of the compared ones. */
export interface CompareItem extends Omit<GraphNode, 'kind'> {
  /** The compared accounts it relates to, as indexes into `accounts`. */
  of: number[]
}

/** How many accounts relate to exactly this subset of the compared. */
export interface CompareCombo {
  of: number[]
  count: number
}

export interface RelationCompare {
  accounts: CompareAccount[]
  /**
   * Accounts that relate to at least `min` of them, the compared ones
   * left out; with `only`, those that relate to exactly that subset. Most
   * shared first, then by follower count, cut at `limit`.
   */
  items: CompareItem[]
  /** Accounts as `items` selects them, beyond the ones returned. */
  total: number
  /**
   * Current follows among the compared accounts and the items,
   * `[follower, followee]` as indexes into `[...accounts, ...items]`.
   */
  edges: [number, number][]
  /** Every subset of at least `min` with accounts, most accounts first. */
  combos: CompareCombo[]
  /** With a viewer asked for. */
  viewer?: GraphViewer
}

export interface CompareQuery {
  /** Account keys, in the order to show them. */
  relOf: readonly string[]
  rel?: CompareSide
  min?: number
  /** Indexes into `relOf`: only accounts related to exactly these. */
  only?: readonly number[]
  limit?: number
  /** An account key whose own follows mark the accounts. */
  viewer?: string
}

const invalid = () => new AppError('invalid_filter')

interface Counted {
  id: string
  platform: string
  kind: string
  external_id: string
  collection_id: string | null
  followers: number | null
  following: number | null
}

/**
 * These accounts' identities, saved profiles and own counts, as their
 * newest capture read them. The ids are materialized once, then each is
 * looked up by index.
 */
function countedAccounts(
  ctx: Reader & Pick<CaptureContext, 'platforms'>,
  ids: readonly string[],
): Map<string, Counted> {
  const found = new Map<string, Counted>()
  if (!ids.length) return found
  const platforms = ctx.db.all<{ platform: string }>(sql`
    SELECT DISTINCT e.platform FROM json_each(${list(ids)}) w
    JOIN entities e ON e.id = w.value`)
  for (const { platform } of platforms) {
    const paths = countPaths(ctx, platform)
    const count = (path: string | undefined) =>
      path
        ? sql`json_extract(cp.metrics,
            '$."' || a.kind || '/' || a.external_id || '"' || ${path})`
        : sql`NULL`
    const rows = ctx.db.all<Counted>(sql`
      WITH ids(id) AS MATERIALIZED (SELECT value FROM json_each(${list(ids)})),
      accounts AS (
        SELECT e.id, e.platform, e.kind, e.external_id, c.id AS collection_id,
          (SELECT cp.id FROM captures cp
            JOIN capture_metrics m ON m.capture_id = cp.id
            WHERE cp.collection_id = c.id
              AND cp.state IN ('complete', 'partial')
            ORDER BY cp.finished_at DESC, cp.id DESC LIMIT 1) AS capture_id
        FROM ids JOIN entities e ON e.id = ids.id
        LEFT JOIN collections c ON c.platform = e.platform
          AND c.kind = substr(e.kind, length(e.platform) + 2)
          AND c.object_scope = '' AND c.external_id = e.external_id
          AND EXISTS (SELECT 1 FROM library l WHERE l.collection_id = c.id)
        WHERE e.platform = ${platform}
      )
      SELECT a.id, a.platform, a.kind, a.external_id, a.collection_id,
        ${count(paths?.followers)} AS followers,
        ${count(paths?.following)} AS following
      FROM accounts a LEFT JOIN capture_metrics cp ON cp.capture_id = a.capture_id`)
    for (const row of rows) found.set(row.id, row)
  }
  return found
}

const counts = (row: Counted | undefined) => ({
  ...(typeof row?.followers === 'number' ? { followers: row.followers } : {}),
  ...(typeof row?.following === 'number' ? { following: row.following } : {}),
  ...(row?.collection_id ? { collection_id: row.collection_id } : {}),
})

const subsetKey = (of: readonly number[]) => of.join(',')

/**
 * The relations of several accounts side by side: for one side (whom they
 * follow, or who follows them), the accounts at least `min` of them share,
 * how many share each exact subset, and the follows among the compared.
 * One pass over each compared account's open follows by the follower or
 * followee index, grouped by the other end; ended follows are left out.
 * Lists are never fetched for this: what is stored is what counts.
 */
export function compareRelations(
  ctx: Reader & Pick<CaptureContext, 'platforms'>,
  query: CompareQuery,
): RelationCompare {
  const keys = [...new Set(query.relOf)]
  const identities = keys.map((key) => parseAuthorKey(key))
  const rel = query.rel ?? 'following'
  const min = query.min ?? defaultRelMin(keys.length)
  const limit = query.limit ?? GRAPH_LIMIT
  const only = query.only
    ? [...new Set(query.only)].toSorted((a, b) => a - b)
    : undefined
  if (
    !keys.length ||
    identities.some((account) => !account?.kind.endsWith('.profile')) ||
    keys.length !== query.relOf.length ||
    !Number.isSafeInteger(min) ||
    min < 1 ||
    min > keys.length ||
    !compareSides.includes(rel) ||
    only?.some((i) => !Number.isSafeInteger(i) || i < 0 || i >= keys.length) ||
    (only && only.length !== query.only!.length)
  )
    throw invalid()
  const wanted = list(
    identities.map((a) => [a!.platform, a!.kind, a!.external]),
  )
  const [mine, other] =
    rel === 'following'
      ? ['follower_id', 'followee_id']
      : ['followee_id', 'follower_id']
  const rows = ctx.db.all<{ id: string; of: string }>(sql`
    WITH p(id, idx) AS MATERIALIZED (
      SELECT e.id, w.key FROM json_each(${wanted}) w
      JOIN entities e ON e.platform = w.value ->> 0
        AND e.kind = w.value ->> 1 AND e.external_id = w.value ->> 2
    )
    SELECT f.${sql.raw(other)} AS id, group_concat(p.idx) AS of
    FROM p JOIN follow_edges f ON f.${sql.raw(mine)} = p.id
      AND f.ended_at IS NULL
    WHERE f.${sql.raw(other)} NOT IN (SELECT id FROM p)
    GROUP BY f.${sql.raw(other)}
    HAVING count(DISTINCT p.idx) >= ${min}`)
  const byCombo = new Map<string, CompareCombo>()
  const qualifying = rows.map((row) => {
    const of = row.of
      .split(',')
      .map(Number)
      .toSorted((a, b) => a - b)
    const key = subsetKey(of)
    const combo = byCombo.get(key)
    if (combo) combo.count++
    else byCombo.set(key, { of, count: 1 })
    return { id: row.id, of, key }
  })
  const combos = [...byCombo.values()].toSorted(
    (a, b) =>
      b.count - a.count ||
      b.of.length - a.of.length ||
      subsetKey(a.of).localeCompare(subsetKey(b.of)),
  )
  const chosen = only
    ? qualifying.filter((row) => row.key === subsetKey(only))
    : qualifying
  // Counts only for the subsets the page reaches: the most shared come
  // first, so a large set of accounts with one in common is rarely read.
  const bySize = new Map<number, typeof chosen>()
  for (const row of chosen) {
    const group = bySize.get(row.of.length)
    if (group) group.push(row)
    else bySize.set(row.of.length, [row])
  }
  const kept: { id: string; of: number[]; counted: Counted }[] = []
  for (const size of [...bySize.keys()].toSorted((a, b) => b - a)) {
    if (kept.length >= limit) break
    const group = bySize.get(size)!
    const counted = countedAccounts(
      ctx,
      group.map((row) => row.id),
    )
    const ranked = group
      .map((row) => ({ ...row, counted: counted.get(row.id)! }))
      .toSorted(
        (a, b) =>
          (b.counted.followers ?? -1) - (a.counted.followers ?? -1) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )
    kept.push(...ranked.slice(0, limit - kept.length))
  }

  const entityIds = ctx.db.all<{ idx: number; id: string }>(sql`
    SELECT w.key AS idx, e.id FROM json_each(${wanted}) w
    JOIN entities e ON e.platform = w.value ->> 0
      AND e.kind = w.value ->> 1 AND e.external_id = w.value ->> 2`)
  const entityOf = new Map(entityIds.map((row) => [row.idx, row.id]))
  const centers = countedAccounts(ctx, [...entityOf.values()])
  const ids = [...entityOf.values(), ...kept.map((row) => row.id)]
  const shown = shownAccounts(ctx, ids)
  const avatars = avatarsOf(ctx, shown)
  const accounts = keys.map((key, i): CompareAccount => {
    const id = entityOf.get(i)
    const identity = identities[i]!
    return {
      ...(id ? { entity_id: id } : {}),
      key,
      external_id: identity.external,
      ...accountLabel(id ? shown.get(id) : undefined, avatars),
      ...counts(id ? centers.get(id) : undefined),
      lists: id ? listsOf(ctx, id) : { following: {}, followers: {} },
    }
  })
  const items = kept.map(({ id, of, counted }): CompareItem => ({
    entity_id: id,
    key: authorKey({
      platform: counted.platform,
      kind: counted.kind,
      external: counted.external_id,
    }),
    external_id: counted.external_id,
    ...accountLabel(shown.get(id), avatars),
    ...counts(counted),
    of,
  }))
  const index = new Map<string, number>()
  keys.forEach((_key, i) => {
    const id = entityOf.get(i)
    if (id) index.set(id, i)
  })
  kept.forEach((row, i) => index.set(row.id, keys.length + i))
  const edges = edgesAmong(ctx, [...index.keys()])
    .map((edge): [number, number] => [
      index.get(edge.follower)!,
      index.get(edge.followee)!,
    ])
    .toSorted((a, b) => a[0] - b[0] || a[1] - b[1])
  const seen = query.viewer
    ? viewerRelations(ctx, query.viewer, [...index.keys()])
    : undefined
  if (seen) {
    for (const [i, account] of accounts.entries()) {
      const relation = account.entity_id
        ? seen.relations.get(account.entity_id)
        : undefined
      if (relation) accounts[i] = { ...account, viewer: relation }
    }
    for (const item of items) {
      const relation = seen.relations.get(item.entity_id)
      if (relation) item.viewer = relation
    }
  }
  return {
    accounts,
    items,
    total: chosen.length,
    edges,
    combos,
    ...(seen ? { viewer: seen.viewer } : {}),
  }
}
