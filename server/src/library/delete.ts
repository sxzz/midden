import { and, isNull, lte, sql, type SQL } from 'drizzle-orm'
import { recordFilterSQL } from '#capture/records.ts'
import { collections, library, submissions, updates } from '#db/schema.ts'
import { inJson } from '#db/sql.ts'
import { AppError } from '#errors.ts'
import { pruneTags } from './annotations.ts'
import { relatedEdgesSQL } from './list.ts'
import { revokeOrphanedShares } from './shares.ts'
import { list } from './views.ts'
import type { Database, Transaction } from '#db/client.ts'

export interface DeleteOptions {
  /**
   * Also delete the posts listed under the selected accounts that only they
   * hold; see `deleteCollections`.
   */
  withPosts?: boolean
  /** Count only; nothing changes. */
  dryRun?: boolean
}

/** What a deletion removes, or would. */
export interface DeleteCounts {
  /** Selected accounts. */
  profiles: number
  /** Selected collections that are not accounts. */
  posts: number
  /** Posts of the selected accounts that go with them. */
  related: number
  /**
   * Posts of the selected accounts that stay, each counted once, by the
   * first reason that holds: another saved account lists them (`listed`),
   * the owner saved them on their own (`saved`), they carry tags or a note
   * (`annotated`), or a saved post that stays quotes or reposts them
   * (`quoted`). Related and kept are all zero without `withPosts`.
   */
  kept: Record<KeepReason, number>
}

/**
 * Why a post of an account stays when the account goes with its posts; see
 * `DeleteCounts.kept`.
 */
export type KeepReason = 'listed' | 'saved' | 'annotated' | 'quoted'

const SELECTED = 'temp.delete_selected'
const RELATED = 'temp.delete_related'

/**
 * Whether the owner saved collection `column` on its own: a request of its
 * own (a capture record) asked for it, and that request was not a refresh.
 * Items of an update (更新) are no records of their own. Older refreshes
 * are told by their key in a refresh batch, or by being the first request of
 * a capture made to refresh; one that joined a capture already running, or
 * a save that did, counts as a save. A collection no request reached at all
 * cannot be told apart, so it counts as saved too.
 */
const savedOnItsOwnSQL = (column: string) => sql`(
  EXISTS (
    SELECT 1 FROM captures c
    JOIN ${submissions} ON ${submissions.captureId} = c.id
    WHERE c.collection_id = ${sql.raw(column)} AND ${recordFilterSQL()}
      AND ${submissions.idemKey} NOT LIKE 'refresh-batch:%'
      AND NOT (c.refresh_from IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM submissions earlier
        WHERE earlier.capture_id = c.id AND (
          earlier.created_at < ${submissions.createdAt}
          OR (earlier.created_at = ${submissions.createdAt}
            AND earlier.id < ${submissions.id})))))
  OR NOT EXISTS (
    SELECT 1 FROM captures c JOIN submissions s ON s.capture_id = c.id
    WHERE c.collection_id = ${sql.raw(column)}))`

/**
 * Candidates that a saved collection staying in the library points at with
 * a quote or a repost from its newest revision's root.
 */
const quotedByRemainingSQL = sql`
  SELECT r.id FROM ${sql.raw(RELATED)} r
  JOIN catalog ck ON ck.collection_id = r.id
  CROSS JOIN entity_versions v ON v.entity_id = ck.root_entity_id
  CROSS JOIN revision_entities target ON target.entity_version_id = v.id
  CROSS JOIN entity_relations relation ON relation.revision_id = target.revision_id
    AND relation.target_key = target.entity_key
    AND relation.kind IN ('quoted', 'reposted')
  CROSS JOIN revision_entities source ON source.revision_id = relation.revision_id
    AND source.entity_key = relation.source_key AND source.is_root = 1
  CROSS JOIN revisions rv ON rv.id = relation.revision_id
  CROSS JOIN catalog sk ON sk.collection_id = rv.collection_id
    AND sk.revision_id = rv.id
  CROSS JOIN library sl ON sl.collection_id = sk.collection_id
  WHERE r.reason IS NULL
    AND sk.collection_id NOT IN (SELECT id FROM ${sql.raw(SELECTED)})
    AND sk.collection_id NOT IN (
      SELECT id FROM ${sql.raw(RELATED)} WHERE reason IS NULL)`

/**
 * Candidates a saved account that stays lists on its page: `relatedEdgesSQL`
 * read from the candidate's side. Either the candidate's newest root points
 * at the account's identity (or an alias of it), or the account's root, in
 * any revision, points at the candidate's identity (or one of its aliases).
 */
const listedByStayingSQL = sql`
  WITH staying AS MATERIALIZED (
    SELECT k.collection_id AS id, k.root_entity_id AS entity_id
    FROM catalog k JOIN library l ON l.collection_id = k.collection_id
    WHERE k.root_kind LIKE '%.profile'
      AND k.collection_id NOT IN (SELECT id FROM ${sql.raw(SELECTED)})
  ),
  identities AS MATERIALIZED (
    SELECT r.id, ck.root_entity_id AS entity_id
    FROM ${sql.raw(RELATED)} r JOIN catalog ck ON ck.collection_id = r.id
    WHERE r.reason IS NULL
    UNION
    SELECT r.id, alias_identity.id
    FROM ${sql.raw(RELATED)} r
    JOIN catalog ck ON ck.collection_id = r.id
    JOIN collections rc ON rc.id = r.id
    JOIN collection_identity_aliases alias ON alias.collection_id = rc.id
      AND alias.platform = rc.platform AND alias.kind = rc.kind
      AND alias.object_scope = rc.object_scope
    JOIN entities identity ON identity.id = ck.root_entity_id
    JOIN entities alias_identity ON alias_identity.platform = identity.platform
      AND alias_identity.kind = identity.kind
      AND alias_identity.external_id = alias.external_id
    WHERE r.reason IS NULL
  )
  SELECT r.id FROM ${sql.raw(RELATED)} r
  CROSS JOIN catalog ck ON ck.collection_id = r.id
  CROSS JOIN entity_relations relation ON relation.revision_id = ck.revision_id
  CROSS JOIN revision_entities source ON source.revision_id = relation.revision_id
    AND source.entity_key = relation.source_key AND source.is_root = 1
  CROSS JOIN revision_entities target ON target.revision_id = relation.revision_id
    AND target.entity_key = relation.target_key
  CROSS JOIN entity_versions tv ON tv.id = target.entity_version_id
  CROSS JOIN entities identity ON identity.id = tv.entity_id
  WHERE r.reason IS NULL AND (
    identity.id IN (SELECT entity_id FROM staying)
    OR EXISTS (
      SELECT 1 FROM collection_identity_aliases alias
      JOIN collections yc ON yc.id = alias.collection_id
        AND yc.platform = alias.platform AND yc.kind = alias.kind
        AND yc.object_scope = alias.object_scope
      JOIN staying ON staying.id = yc.id
      JOIN entities account ON account.id = staying.entity_id
      WHERE alias.platform = identity.platform
        AND alias.external_id = identity.external_id
        AND account.platform = identity.platform
        AND account.kind = identity.kind))
  UNION
  SELECT identities.id FROM identities
  CROSS JOIN entity_versions v ON v.entity_id = identities.entity_id
  CROSS JOIN revision_entities target ON target.entity_version_id = v.id
  CROSS JOIN entity_relations relation ON relation.revision_id = target.revision_id
    AND relation.target_key = target.entity_key
  CROSS JOIN revision_entities source ON source.revision_id = relation.revision_id
    AND source.entity_key = relation.source_key AND source.is_root = 1
  CROSS JOIN revisions rv ON rv.id = relation.revision_id
  WHERE rv.collection_id IN (SELECT id FROM staying)`

function dropTemp(tx: Transaction) {
  tx.run(sql.raw(`DROP TABLE IF EXISTS ${SELECTED}`))
  tx.run(sql.raw(`DROP TABLE IF EXISTS ${RELATED}`))
}

const count = (tx: Transaction, query: SQL) =>
  tx.get<{ n: number }>(sql`SELECT count(*) AS n FROM (${query})`)?.n ?? 0

/**
 * The posts listed under the selected accounts (as their pages list them,
 * see `relatedEdgesSQL`) other than those that only mention them, and the
 * posts their own posts quote or repost, into `RELATED`, each with the
 * reason it stays or none.
 */
function collectRelated(tx: Transaction): void {
  tx.run(
    sql.raw(`CREATE TEMP TABLE ${RELATED.slice(5)} (
      id TEXT PRIMARY KEY, authored INTEGER NOT NULL, reason TEXT
    ) WITHOUT ROWID`),
  )
  tx.run(sql`
    INSERT INTO ${sql.raw(RELATED)} (id, authored)
    WITH ${relatedEdgesSQL(sql`SELECT id FROM ${sql.raw(SELECTED)} WHERE profile`)}
    SELECT e.collection_id, max(e.kind = 'authored_by')
    FROM related_edges e
    JOIN catalog pk ON pk.collection_id = e.requested_id
    JOIN catalog k ON k.collection_id = e.collection_id
    JOIN library l ON l.collection_id = e.collection_id
    WHERE k.root_kind = replace(pk.root_kind, '.profile', '.post')
      -- Mentioning him lists a post on his page but does not make it his.
      AND e.kind <> 'mentions'
      AND e.collection_id NOT IN (SELECT id FROM ${sql.raw(SELECTED)})
    GROUP BY e.collection_id`)
  // What his own posts quote or repost came in with them.
  tx.run(sql`
    INSERT OR IGNORE INTO ${sql.raw(RELATED)} (id, authored)
    SELECT DISTINCT k.collection_id, 0
    FROM ${sql.raw(RELATED)} r
    CROSS JOIN catalog rk ON rk.collection_id = r.id
    CROSS JOIN entity_relations relation ON relation.revision_id = rk.revision_id
      AND relation.kind IN ('quoted', 'reposted')
    CROSS JOIN revision_entities source ON source.revision_id = relation.revision_id
      AND source.entity_key = relation.source_key AND source.is_root = 1
    CROSS JOIN revision_entities target ON target.revision_id = relation.revision_id
      AND target.entity_key = relation.target_key
    CROSS JOIN entity_versions tv ON tv.id = target.entity_version_id
    CROSS JOIN catalog k ON k.root_entity_id = tv.entity_id AND k.root_kind = rk.root_kind
    CROSS JOIN library l ON l.collection_id = k.collection_id
    WHERE r.authored
      AND k.collection_id NOT IN (SELECT id FROM ${sql.raw(SELECTED)})`)

  const keep = (reason: string, where: SQL) =>
    tx.run(sql`UPDATE ${sql.raw(RELATED)} SET reason = ${reason}
      WHERE reason IS NULL AND ${where}`).changes
  keep('listed', sql`id IN (${listedByStayingSQL})`)
  keep('saved', savedOnItsOwnSQL('delete_related.id'))
  keep(
    'annotated',
    sql`id IN (
      SELECT collection_id FROM library
      WHERE collection_id IN (SELECT id FROM ${sql.raw(RELATED)}) AND note <> ''
      UNION
      SELECT collection_id FROM collection_tags
      WHERE collection_id IN (SELECT id FROM ${sql.raw(RELATED)}))`,
  )
  // Keeping one post can keep what it quotes in turn.
  let more = true
  while (more) more = keep('quoted', sql`id IN (${quotedByRemainingSQL})`) > 0
}

/** The saved collections among `ids` into `SELECTED`, accounts marked. */
function select(tx: Transaction, ids: readonly string[]): void {
  dropTemp(tx)
  tx.run(
    sql.raw(`CREATE TEMP TABLE ${SELECTED.slice(5)} (
      id TEXT PRIMARY KEY, profile INTEGER NOT NULL
    ) WITHOUT ROWID`),
  )
  tx.run(sql`
    INSERT INTO ${sql.raw(SELECTED)} (id, profile)
    SELECT l.collection_id,
      coalesce(k.root_kind LIKE '%.profile', c.kind = 'profile')
    FROM library l
    JOIN collections c ON c.id = l.collection_id
    LEFT JOIN catalog k ON k.collection_id = l.collection_id
    WHERE l.collection_id IN (SELECT value FROM json_each(${list(ids)}))`)
}

/** A post of an account and why it stays, or null when it goes with it. */
export interface AccountPost {
  id: string
  reason: KeepReason | null
}

/**
 * The posts of the saved accounts among `ids` exactly as deleting them with
 * their posts (`withPosts`) picks them, changing nothing: each with the
 * first reason it would stay for, or null when it would go with them.
 * Other saved accounts stay, so they hold what they list.
 */
export function accountPosts(
  tx: Transaction,
  ids: readonly string[],
): AccountPost[] {
  select(tx, ids)
  collectRelated(tx)
  const posts = tx.all<AccountPost>(
    sql`SELECT id, reason FROM ${sql.raw(RELATED)} ORDER BY id`,
  )
  dropTemp(tx)
  return posts
}

/**
 * Remove saved collections from the library in one transaction; their
 * content is collected by maintenance once no capture of them is running.
 * Ids not in the library are skipped; when none is, `not_found`.
 *
 * With `withPosts`, the posts listed under each selected account go too,
 * except those that only mention it, and unless another saved account that stays lists them as well, the owner
 * saved them on their own rather than through an account's timeline or a
 * post's references, they carry tags or a note, or a saved post that stays
 * quotes or reposts them. The posts the accounts' own posts quote or repost
 * count as theirs.
 */
export function deleteCollections(
  db: Database,
  ids: readonly string[],
  options: DeleteOptions = {},
): DeleteCounts {
  return db.transaction((tx) => {
    select(tx, ids)
    const profiles = count(
      tx,
      sql`SELECT 1 FROM ${sql.raw(SELECTED)} WHERE profile`,
    )
    const others = count(
      tx,
      sql`SELECT 1 FROM ${sql.raw(SELECTED)} WHERE NOT profile`,
    )
    if (!profiles && !others) {
      dropTemp(tx)
      throw new AppError('not_found')
    }
    const kept = { listed: 0, saved: 0, annotated: 0, quoted: 0 }
    let related = 0
    const withPosts = !!options.withPosts && profiles > 0
    if (withPosts) {
      collectRelated(tx)
      for (const row of tx.all<{ reason: string | null; n: number }>(
        sql`SELECT reason, count(*) AS n FROM ${sql.raw(RELATED)} GROUP BY reason`,
      )) {
        if (row.reason) kept[row.reason as keyof typeof kept] = row.n
        else related = row.n
      }
    }
    if (!options.dryRun) {
      const removed = sql`
        SELECT id FROM ${sql.raw(SELECTED)}
        ${withPosts ? sql`UNION ALL SELECT id FROM ${sql.raw(RELATED)} WHERE reason IS NULL` : sql``}`
      tx.run(sql`DELETE FROM library WHERE collection_id IN (${removed})`)
      pruneTags(tx)
      revokeOrphanedShares(tx)
      tx.run(sql`UPDATE collections SET unreferenced_at = ${Date.now()}
        WHERE id IN (${removed}) AND unreferenced_at IS NULL`)
    }
    dropTemp(tx)
    return { profiles, posts: others, related, kept }
  })
}

/**
 * Remove a collection from the library. Its content is collected by
 * maintenance once no capture of it is running.
 */
export function deleteCollection(db: Database, collectionId: string): void {
  deleteCollections(db, [collectionId])
}

/**
 * Empty the library and the capture records up to `before`. Requests in
 * flight stop expanding: their submissions are gone.
 */
export function deleteAll(
  db: Database,
  before = new Date(),
): { collections: number; records: number } {
  return db.transaction((tx) => {
    const saved = tx
      .select({ id: library.collectionId })
      .from(library)
      .where(lte(library.createdAt, before))
      .all()
      .map((row) => row.id)
    const records =
      (tx
        .select({ n: sql<number>`count(*)`.mapWith(Number) })
        .from(submissions)
        .where(and(recordFilterSQL(), lte(submissions.createdAt, before)))
        .get()?.n ?? 0) +
      (tx
        .select({ n: sql<number>`count(*)`.mapWith(Number) })
        .from(updates)
        .where(lte(updates.createdAt, before))
        .get()?.n ?? 0)
    // By time rather than by id: a list of every saved id can exceed
    // SQLite's limit on bound values.
    tx.delete(library).where(lte(library.createdAt, before)).run()
    pruneTags(tx)
    revokeOrphanedShares(tx)
    tx.update(collections)
      .set({ unreferencedAt: before })
      .where(
        and(
          inJson(collections.id, saved),
          isNull(collections.unreferencedAt),
          sql`NOT EXISTS (SELECT 1 FROM ${library} WHERE ${library.collectionId} = ${collections.id})`,
        ),
      )
      .run()
    tx.delete(submissions).where(lte(submissions.createdAt, before)).run()
    tx.delete(updates).where(lte(updates.createdAt, before)).run()
    return { collections: saved.length, records }
  })
}
