import { sql } from 'drizzle-orm'
import { assertSaved } from './read.ts'
import {
  assetsById,
  avatarOf,
  iso,
  parseJson,
  type AssetView,
  type Reader,
} from './views.ts'

/** Follows observed now, from the stored edges; absent without any. */
export interface FollowCounts {
  following?: number
  followers?: number
  mutual?: number
}

/**
 * 新关注 and 取关 are the account's own follows starting and ending; 新粉丝 and
 * 掉粉 are others' follows of it.
 */
export type FollowChangeType =
  'follow' | 'unfollow' | 'followed_by' | 'unfollowed_by'

export interface FollowAccount {
  entity_id: string
  external_id: string
  name?: string
  username?: string
  /** The account's saved profile. */
  collection_id?: string
  avatar?: AssetView
}

/**
 * A follow seen starting or ending. Times are when fetches saw it: it
 * happened after `since` (the last fetch that saw the old state) and before
 * `observed_at` (the one that saw the new).
 */
export interface FollowChange {
  type: FollowChangeType
  observed_at: string
  since?: string
  account: FollowAccount
}

export interface FollowChanges {
  /** Newest first. */
  items: FollowChange[]
  /** More changes exist beyond `limit`. */
  truncated?: boolean
}

export const FOLLOW_CHANGES_LIMIT = 1000

/** The account a saved profile is about: the root of its newest revision. */
function subjectOf(r: Reader, id: string): string | undefined {
  assertSaved(r, id)
  return (
    r.db.get<{ id: string | null }>(
      sql`SELECT root_entity_id AS id FROM catalog
        WHERE collection_id = ${id} AND root_kind LIKE '%.profile'`,
    )?.id ?? undefined
  )
}

/**
 * How many accounts the profile follows, follow it, and both, as far as
 * stored follows tell; nothing when no follow of it was ever seen.
 */
export function followCounts(r: Reader, id: string): FollowCounts {
  const subject = subjectOf(r, id)
  if (!subject) return {}
  const row = r.db.get<{
    following: number
    followers: number
    mutual: number
    seen: number
  }>(sql`SELECT
      (SELECT count(*) FROM follow_edges
        WHERE follower_id = ${subject} AND ended_at IS NULL) AS following,
      (SELECT count(*) FROM follow_edges
        WHERE followee_id = ${subject} AND ended_at IS NULL) AS followers,
      (SELECT count(*) FROM follow_edges a
        WHERE a.follower_id = ${subject} AND a.ended_at IS NULL
          AND EXISTS (SELECT 1 FROM follow_edges b
            WHERE b.follower_id = a.followee_id AND b.followee_id = ${subject}
              AND b.ended_at IS NULL)) AS mutual,
      EXISTS (SELECT 1 FROM follow_edges WHERE follower_id = ${subject})
        OR EXISTS (SELECT 1 FROM follow_edges WHERE followee_id = ${subject})
        AS seen`)
  if (!row?.seen) return {}
  return {
    following: row.following,
    followers: row.followers,
    mutual: row.mutual,
  }
}

/**
 * When each list of the account was completely fetched, oldest first. A
 * follow first seen after the first of them was not in that list, so it is a
 * change; one seen before (or with no complete fetch at all) may always have
 * been there.
 */
function completeFetches(
  r: Reader,
  subject: string,
): Record<'following' | 'followers', number[]> {
  const rows = r.db.all<{ list: 'following' | 'followers'; at: number }>(
    sql`SELECT list, finished_at AS at FROM relation_fetches
      WHERE entity_id = ${subject} AND state = 'complete'
      ORDER BY finished_at`,
  )
  return {
    following: rows.filter((r) => r.list === 'following').map((r) => r.at),
    followers: rows.filter((r) => r.list === 'followers').map((r) => r.at),
  }
}

/** The newest time before `at`, if any. */
function before(times: number[], at: number): number | undefined {
  let found: number | undefined
  for (const time of times) if (time < at) found = time
  return found
}

/**
 * The follow changes of a saved profile, newest first: follows of it and
 * by it that started after a complete fetch of the list holding them, and
 * those that ended (only a complete fetch ends one). Up to `limit`.
 */
export function listFollowChanges(
  r: Reader,
  id: string,
  limit = FOLLOW_CHANGES_LIMIT,
): FollowChanges {
  const subject = subjectOf(r, id)
  if (!subject) return { items: [] }
  const complete = completeFetches(r, subject)
  // NULL when the list was never complete: then no start is a change.
  const baseFollowing = complete.following[0] ?? null
  const baseFollowers = complete.followers[0] ?? null
  const rows = r.db.all<{
    type: FollowChangeType
    other: string
    at: number
    since: number | null
    external_id: string
    data: string | null
    collection_id: string | null
    avatar: string | null
  }>(sql`
    WITH events AS (
      SELECT 'follow' AS type, followee_id AS other, first_seen_at AS at,
        NULL AS since
      FROM follow_edges
      WHERE follower_id = ${subject} AND first_seen_at > ${baseFollowing}
      UNION ALL
      SELECT 'unfollow', followee_id, ended_at, last_seen_at
      FROM follow_edges
      WHERE follower_id = ${subject} AND ended_at IS NOT NULL
      UNION ALL
      SELECT 'followed_by', follower_id, first_seen_at, NULL
      FROM follow_edges
      WHERE followee_id = ${subject} AND first_seen_at > ${baseFollowers}
      UNION ALL
      SELECT 'unfollowed_by', follower_id, ended_at, last_seen_at
      FROM follow_edges
      WHERE followee_id = ${subject} AND ended_at IS NOT NULL
      ORDER BY at DESC, type, other
      LIMIT ${limit + 1}
    )
    SELECT ev.type, ev.other, ev.at, ev.since, e.external_id,
      coalesce(own.data, (SELECT v.data FROM entity_versions v
        WHERE v.entity_id = e.id ORDER BY v.created_at DESC, v.id DESC
        LIMIT 1)) AS data,
      c.id AS collection_id,
      ${sql.raw(avatarOf('rv', 're.entity_key'))} AS avatar
    FROM events ev
    JOIN entities e ON e.id = ev.other
    LEFT JOIN collections c ON c.platform = e.platform
      AND c.kind = substr(e.kind, length(e.platform) + 2)
      AND c.object_scope = '' AND c.external_id = e.external_id
      AND EXISTS (SELECT 1 FROM library l WHERE l.collection_id = c.id)
    LEFT JOIN revisions rv ON rv.id = c.current_revision
    LEFT JOIN revision_entities re ON re.revision_id = rv.id AND re.is_root = 1
    LEFT JOIN entity_versions own ON own.id = re.entity_version_id
      AND own.entity_id = e.id
    ORDER BY ev.at DESC, ev.type, ev.other`)
  const truncated = rows.length > limit
  const kept = rows.slice(0, limit)
  const avatars = assetsById(
    r,
    kept.flatMap((row) => (row.avatar ? [row.avatar] : [])),
  )
  return {
    items: kept.map((row) => {
      const data = row.data ? parseJson<Record<string, unknown>>(row.data) : {}
      const since =
        row.since ??
        before(
          row.type === 'follow' ? complete.following : complete.followers,
          row.at,
        )
      const avatar = row.avatar ? avatars.get(row.avatar) : undefined
      return {
        type: row.type,
        observed_at: iso(row.at),
        ...(since === undefined ? {} : { since: iso(since) }),
        account: {
          entity_id: row.other,
          external_id: row.external_id,
          ...(typeof data.name === 'string' && data.name
            ? { name: data.name }
            : {}),
          ...(typeof data.username === 'string' && data.username
            ? { username: data.username }
            : {}),
          ...(row.collection_id ? { collection_id: row.collection_id } : {}),
          ...(avatar ? { avatar } : {}),
        },
      }
    }),
    ...(truncated && { truncated }),
  }
}
