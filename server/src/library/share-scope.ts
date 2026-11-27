import { sql } from 'drizzle-orm'
import { selectedAmong, type CollectionFilter } from './list.ts'
import { list } from './views.ts'
import type { Executor } from '#db/client.ts'
import type { FolderSelection } from './folder-query.ts'

/** What a share makes public, decided anew on every request. */
export interface ShareScope {
  /** Which of these collections the share makes readable. */
  contains: (ids: readonly string[]) => Set<string>
  /**
   * The filter listing a profile's attached posts, when the share shows
   * that profile's page: the shared profile, or one a shared folder holds.
   */
  profilePosts: (id: string) => CollectionFilter | undefined
}

const PROFILE_SUFFIX = /\.profile$/

const isProfile = (kind: string | null | undefined) =>
  !!kind?.endsWith('.profile')

/** The root type of each saved collection, as the catalog keeps it. */
function rootKinds(db: Executor, ids: readonly string[]) {
  if (!ids.length) return new Map<string, string | null>()
  return new Map(
    db
      .all<{ id: string; kind: string | null }>(
        sql`SELECT k.collection_id AS id, k.root_kind AS kind
          FROM catalog k JOIN library l ON l.collection_id = k.collection_id
          WHERE k.collection_id IN (SELECT value FROM json_each(${list(ids)}))`,
      )
      .map((row) => [row.id, row.kind]),
  )
}

/**
 * The list under a profile's page: its related posts of its own platform,
 * the same request the private page makes.
 */
function postsOf(kind: string, id: string): CollectionFilter {
  return { relatedTo: id, entityType: kind.replace(PROFILE_SUFFIX, '.post') }
}

/**
 * Profiles that might list one of these collections among their attached
 * posts: every profile whose identity (or an alias of it) appears in one of
 * them, and every profile whose revisions name one of their roots. A
 * superset; the profile's own list decides.
 */
function profileCandidates(db: Executor, ids: readonly string[]): string[] {
  if (!ids.length) return []
  return db
    .all<{ id: string }>(
      sql`
    WITH wanted AS (SELECT value AS id FROM json_each(${list(ids)})),
    seen AS MATERIALIZED (
      SELECT DISTINCT e.platform, e.kind, e.external_id
      FROM wanted
      JOIN revisions r ON r.collection_id = wanted.id
      JOIN revision_entities re ON re.revision_id = r.id
      JOIN entity_versions v ON v.id = re.entity_version_id
      JOIN entities e ON e.id = v.entity_id
    ),
    roots AS MATERIALIZED (
      SELECT DISTINCT v.entity_id AS id
      FROM wanted
      JOIN revisions r ON r.collection_id = wanted.id
      JOIN revision_entities re ON re.revision_id = r.id AND re.is_root = 1
      JOIN entity_versions v ON v.id = re.entity_version_id
      UNION
      SELECT e.id FROM wanted
      JOIN catalog k ON k.collection_id = wanted.id
      JOIN collection_identity_aliases a ON a.collection_id = wanted.id
      JOIN entities e ON e.platform = a.platform AND e.kind = k.root_kind
        AND e.external_id = a.external_id
    )
    SELECT DISTINCT k.collection_id AS id FROM catalog k
    JOIN library l ON l.collection_id = k.collection_id
    WHERE k.root_kind LIKE '%.profile' AND (
      k.root_entity_id IN (
        SELECT e.id FROM seen
        JOIN entities e ON e.platform = seen.platform AND e.kind = seen.kind
          AND e.external_id = seen.external_id)
      OR k.collection_id IN (
        SELECT a.collection_id FROM seen
        CROSS JOIN collection_identity_aliases a
          ON a.platform = seen.platform AND a.external_id = seen.external_id)
      OR k.collection_id IN (
        SELECT r.collection_id FROM roots
        CROSS JOIN entity_versions v ON v.entity_id = roots.id
        CROSS JOIN revision_entities re ON re.entity_version_id = v.id
        CROSS JOIN revisions r ON r.id = re.revision_id))`,
    )
    .map((row) => row.id)
}

/** A saved profile's page with its posts, or a single saved post. */
export function collectionScope(db: Executor, id: string): ShareScope {
  const kind = rootKinds(db, [id]).get(id)
  if (!isProfile(kind))
    return {
      contains: (ids) =>
        new Set(ids.includes(id) && rootKinds(db, [id]).has(id) ? [id] : []),
      profilePosts: () => undefined,
    }
  const posts = postsOf(kind!, id)
  return {
    contains(ids) {
      const found = selectedAmong(db, posts, ids)
      if (ids.includes(id) && rootKinds(db, [id]).has(id)) found.add(id)
      return found
    },
    profilePosts: (wanted) => (wanted === id ? posts : undefined),
  }
}

/**
 * What a folder's query selects now, and the attached posts of every
 * profile among them, as each profile's page lists them.
 */
export function folderScope(
  db: Executor,
  selection: FolderSelection,
): ShareScope {
  const among = (ids: readonly string[]) =>
    selectedAmong(db, selection.filter, ids, selection.extra)
  const profilePosts = (id: string) => {
    const kind = rootKinds(db, [id]).get(id)
    return isProfile(kind) && among([id]).has(id)
      ? postsOf(kind!, id)
      : undefined
  }
  return {
    contains(ids) {
      const found = among(ids)
      let rest = ids.filter((id) => !found.has(id))
      if (!rest.length) return found
      const candidates = profileCandidates(db, rest)
      const kinds = rootKinds(db, candidates)
      for (const profile of among(candidates)) {
        const kind = kinds.get(profile)
        if (!isProfile(kind)) continue
        for (const id of selectedAmong(db, postsOf(kind!, profile), rest))
          found.add(id)
        rest = rest.filter((id) => !found.has(id))
        if (!rest.length) break
      }
      return found
    },
    profilePosts,
  }
}
