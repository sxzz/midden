// An update's progress, kept as it changes. The counts an update shows (how
// many members are complete, partial, failed, pending, new, updated) were
// counted over all of its members on every read: tens of thousands for a
// large update, 50 to 100 ms per 12,000. Now they are read from rows the
// worker keeps up to date, and a read costs a few lookups.
//
// What is kept:
//
//   update_members   one row per collection of the update: its newest
//                    capture, that capture's state, and whether any listing
//                    of the collection saved it as new. The same collection
//                    submitted several times (as an item, on several pages,
//                    again after a retry) is one member; the newest capture
//                    wins; it is new if any listing was.
//   update_pages     the pages of the timelines of the update's profiles,
//                    each profile's chain, whose listings are members.
//   update_progress  those members counted by state; one row.
//
// How it is kept exact: triggers write the ids of what changed to
// `member_events` (a submission, a capture's state, ...), once each. The
// worker settles them every second (`settleProgress`), in one write
// transaction: it works out which updates and which collections they touch,
// counts those again from the sources with the same rules as a full count
// (`countMembersFull`), writes the rows that changed, and counts the
// update's rows by state. A row is thus always what the sources say for its
// collection, however the changes came, and the counts are the rows'; there
// are no increments to drift. Batching means a capture that changes state
// five times in a second is one write. Writers other than the worker (the
// web process, tests) settle before they read; a read thread, whose
// connection cannot write, reads what the worker last settled: up to a
// second behind.
//
// What is not kept: what depends on things outside the members (whether a
// failed member saw its source gone again, whether it can be retried, media
// that failed) is told when read, over the members that failed or are
// partial only, which are few. `verifyMembers` and `countMembersFull` count
// from scratch to compare, in tests and in the worker's maintenance.
import { sql } from 'drizzle-orm'
import { knownGoneSQL, missingMediaSQL } from './retry-units.ts'
import type { Executor } from '#db/client.ts'

const MAX_DEPTH = 1000
/** The most events one settling takes up; the rest wait for the next. */
const BATCH = 20_000

let canWrite = true

/** On a read thread (a read-only connection): never settle, only read. */
export function readOnlyProgress(on = true): void {
  canWrite = !on
}

interface Row {
  collection: string
  capture: string
  state: string
  added: number | null
}

const isTracked = (db: Executor, id: string) =>
  db.all(sql`SELECT 1 FROM update_progress WHERE update_id = ${id}`).length > 0

/** The ids of an update's timeline pages: each profile's chain, from its item. */
function chainPages(db: Executor, id: string): string[] {
  return db
    .all<{ id: string }>(
      sql`
    WITH RECURSIVE chain(id, depth) AS (
      SELECT s.id, 1 FROM submissions s
      JOIN captures c ON c.id = s.capture_id
      WHERE s.update_id = ${id} AND c.is_collection AND s.related_state <> 'none'
      UNION ALL
      SELECT s.next_submission, chain.depth + 1
      FROM chain JOIN submissions s ON s.id = chain.id
      WHERE s.next_submission IS NOT NULL AND chain.depth < ${MAX_DEPTH}
    )
    SELECT DISTINCT id FROM chain`,
    )
    .map((row) => row.id)
}

/**
 * What the update's members are, as the sources say: one row per
 * collection, of its newest capture, new if any listing of it was. Over all
 * of the update, or only the collections named.
 */
function population(
  db: Executor,
  id: string,
  collections?: readonly string[],
): Row[] {
  const sources = collections
    ? sql`
      SELECT s.capture_id, s.library_added AS added
      FROM captures c JOIN submissions s ON s.capture_id = c.id
      WHERE c.collection_id IN (SELECT value FROM json_each(${JSON.stringify(collections)}))
        AND (s.update_id = ${id} OR (s.idem_key LIKE 'related:%'
          AND s.parent_submission IN
            (SELECT page_id FROM update_pages WHERE update_id = ${id})))`
    : sql`
      SELECT s.capture_id, s.library_added AS added
      FROM submissions s WHERE s.update_id = ${id}
      UNION ALL
      SELECT s.capture_id, s.library_added
      FROM update_pages p JOIN submissions s ON s.parent_submission = p.page_id
      WHERE p.update_id = ${id} AND s.idem_key LIKE 'related:%'`
  return db.all<Row>(sql`
    WITH src(capture_id, added) AS (${sources}),
    captured AS (
      SELECT c.id AS id, c.collection_id AS collection, c.state AS state,
        c.created_at AS created, max(src.added) AS added
      FROM src JOIN captures c ON c.id = src.capture_id
      JOIN collections a ON a.id = c.collection_id
      GROUP BY c.id
    ),
    ranked AS (
      SELECT *,
        row_number() OVER (PARTITION BY collection ORDER BY created DESC, id DESC)
          AS n,
        max(added) OVER (PARTITION BY collection) AS any_added
      FROM captured
    )
    SELECT collection, id AS capture, state, any_added AS added
    FROM ranked WHERE n = 1`)
}

const sameRow = (a: Row, b: Row) =>
  a.capture === b.capture && a.state === b.state && a.added === b.added

/**
 * Make the rows of these collections (all of the update's when absent) what
 * `rows` say, writing only what differs.
 */
function applyRows(
  db: Executor,
  id: string,
  rows: Row[],
  collections?: readonly string[],
): number {
  let written = 0
  const existing = new Map(
    db
      .all<Row>(
        collections
          ? sql`SELECT collection_id AS collection, capture_id AS capture, state, added
              FROM update_members WHERE update_id = ${id}
              AND collection_id IN (SELECT value FROM json_each(${JSON.stringify(collections)}))`
          : sql`SELECT collection_id AS collection, capture_id AS capture, state, added
              FROM update_members WHERE update_id = ${id}`,
      )
      .map((row) => [row.collection, row]),
  )
  for (const row of rows) {
    const before = existing.get(row.collection)
    existing.delete(row.collection)
    if (before && sameRow(before, row)) continue
    written++
    db.run(sql`
      INSERT INTO update_members (update_id, collection_id, capture_id, state, added)
      VALUES (${id}, ${row.collection}, ${row.capture}, ${row.state}, ${row.added})
      ON CONFLICT (update_id, collection_id) DO UPDATE SET
        capture_id = excluded.capture_id, state = excluded.state,
        added = excluded.added`)
  }
  for (const gone of existing.keys()) {
    written++
    db.run(
      sql`DELETE FROM update_members WHERE update_id = ${id} AND collection_id = ${gone}`,
    )
  }
  return written
}

/** Count the update's rows by state. */
function refreshProgress(db: Executor, id: string): void {
  db.run(sql`
    INSERT INTO update_progress (update_id, total, complete, complete_added,
      complete_updated, partial, partial_added, partial_updated, failed, pending)
    SELECT ${id}, count(*),
      count(*) FILTER (WHERE state = 'complete'),
      count(*) FILTER (WHERE state = 'complete' AND added = 1),
      count(*) FILTER (WHERE state = 'complete' AND added = 0),
      count(*) FILTER (WHERE state = 'partial'),
      count(*) FILTER (WHERE state = 'partial' AND added = 1),
      count(*) FILTER (WHERE state = 'partial' AND added = 0),
      count(*) FILTER (WHERE state = 'failed'),
      count(*) FILTER (WHERE state IN ('queued', 'downloading'))
    FROM update_members WHERE update_id = ${id}
    ON CONFLICT (update_id) DO UPDATE SET
      total = excluded.total, complete = excluded.complete,
      complete_added = excluded.complete_added,
      complete_updated = excluded.complete_updated,
      partial = excluded.partial, partial_added = excluded.partial_added,
      partial_updated = excluded.partial_updated, failed = excluded.failed,
      pending = excluded.pending`)
}

/** Make `update_pages` the update's chains now; the pages that came or went. */
function syncPages(
  db: Executor,
  id: string,
): { added: string[]; removed: string[] } {
  const wanted = new Set(chainPages(db, id))
  const have = new Set(
    db
      .all<{ id: string }>(
        sql`SELECT page_id AS id FROM update_pages WHERE update_id = ${id}`,
      )
      .map((row) => row.id),
  )
  const added = [...wanted].filter((page) => !have.has(page))
  const removed = [...have].filter((page) => !wanted.has(page))
  for (const page of added)
    db.run(
      sql`INSERT OR REPLACE INTO update_pages (page_id, update_id) VALUES (${page}, ${id})`,
    )
  for (const page of removed)
    db.run(sql`DELETE FROM update_pages WHERE page_id = ${page}`)
  return { added, removed }
}

/** The collections of the members listed on these pages. */
function listedCollections(db: Executor, pages: string[]): string[] {
  if (!pages.length) return []
  return db
    .all<{ id: string }>(
      sql`
    SELECT DISTINCT c.collection_id AS id
    FROM submissions s JOIN captures c ON c.id = s.capture_id
    WHERE s.parent_submission IN (SELECT value FROM json_each(${JSON.stringify(pages)}))
      AND s.idem_key LIKE 'related:%'`,
    )
    .map((row) => row.id)
}

/** Keep an update from scratch: its pages, its members and its counts. */
export function rebuildProgress(db: Executor, id: string): void {
  db.transaction((tx) => {
    syncPages(tx, id)
    applyRows(tx, id, population(tx, id))
    refreshProgress(tx, id)
  })
}

/** Whether the update's progress is kept. */
export const progressKept = isTracked

/**
 * Take up what changed since the last settling: update the rows of the
 * members it touches, and count them. Returns how many events it took up.
 * Updates whose progress is not kept yet are left to `adoptUpdates`.
 */
export function settleProgress(db: Executor): number {
  return db.transaction((tx) => {
    const events = tx.all<{ id: number; kind: string; ref: string }>(
      sql`SELECT id, kind, ref FROM member_events ORDER BY id LIMIT ${BATCH}`,
    )
    if (!events.length) return 0
    const kept = new Map<string, boolean>()
    const tracked = (id: string | null | undefined): id is string => {
      if (!id) return false
      if (!kept.has(id)) kept.set(id, isTracked(tx, id))
      return kept.get(id)!
    }
    const touched = new Set<string>()
    // Whose submissions changed: their pages may have too.
    const structural = new Set<string>()
    const pairs = new Map<string, Set<string>>()
    const touch = (
      id: string | null | undefined,
      collection?: string,
      pages = true,
    ) => {
      if (!tracked(id)) return
      touched.add(id)
      if (pages) structural.add(id)
      if (!collection) return
      if (!pairs.has(id)) pairs.set(id, new Set())
      pairs.get(id)!.add(collection)
    }
    const pageOwner = (page: string | null) =>
      page
        ? (tx.all<{ id: string }>(
            sql`SELECT update_id AS id FROM update_pages WHERE page_id = ${page}`,
          )[0]?.id ??
          tx.all<{ id: string }>(
            sql`SELECT update_id AS id FROM submissions WHERE id = ${page} AND update_id IS NOT NULL`,
          )[0]?.id)
        : undefined
    for (const event of events)
      switch (event.kind) {
        case 'u':
          touch(event.ref)
          break
        case 'p':
          touch(pageOwner(event.ref))
          break
        case 's': {
          const [sub] = tx.all<{
            update: string | null
            parent: string | null
            collection: string
          }>(sql`
            SELECT s.update_id AS "update", s.parent_submission AS parent,
              c.collection_id AS collection
            FROM submissions s JOIN captures c ON c.id = s.capture_id
            WHERE s.id = ${event.ref}`)
          if (sub) touch(sub.update ?? pageOwner(sub.parent), sub.collection)
          break
        }
        case 'c':
          for (const row of tx.all<{ update: string; collection: string }>(sql`
            SELECT update_id AS "update", collection_id AS collection
            FROM update_members WHERE capture_id = ${event.ref}`))
            touch(row.update, row.collection, false)
          break
      }
    for (const id of touched) {
      // Pages that joined or left: their listings' members come or go.
      let changed = 0
      if (structural.has(id)) {
        const { added, removed } = syncPages(tx, id)
        changed += added.length + removed.length
        for (const collection of listedCollections(tx, [...added, ...removed]))
          touch(id, collection)
      }
      const collections = [...(pairs.get(id) ?? [])]
      if (collections.length)
        changed += applyRows(
          tx,
          id,
          population(tx, id, collections),
          collections,
        )
      if (changed) refreshProgress(tx, id)
    }
    tx.run(sql`DELETE FROM member_events WHERE id <= ${events.at(-1)!.id}`)
    return events.length
  })
}

/**
 * Start keeping the progress of updates that have none (those from before it
 * was kept, new ones), running ones and the newest first. Returns how many.
 * Finished ones can wait (`onlyRunning`) while the worker is busy: building
 * one costs about 0.4 s for 12,000 members.
 */
export function adoptUpdates(
  db: Executor,
  limit = 2,
  onlyRunning = false,
): number {
  const ids = db
    .all<{ id: string }>(
      sql`
    SELECT u.id FROM updates u
    WHERE NOT EXISTS (SELECT 1 FROM update_progress p WHERE p.update_id = u.id)
      AND (${onlyRunning ? 0 : 1} OR u.state = 'running')
    ORDER BY u.state = 'running' DESC, u.created_at DESC LIMIT ${limit}`,
    )
    .map((row) => row.id)
  for (const id of ids) rebuildProgress(db, id)
  return ids.length
}

/**
 * Bring what is kept up to date before a read of this update, where this
 * connection can write; returns whether its progress is kept.
 */
export function readyProgress(db: Executor, id: string): boolean {
  if (canWrite) {
    settleProgress(db)
    if (!isTracked(db, id)) rebuildProgress(db, id)
    return true
  }
  return isTracked(db, id)
}

/** The members of an update by what a count of them says. */
export interface KeptCounts {
  total: number
  complete: number
  partial: number
  failed: number
  pending: number
  known: number
  retryable: number
  added: number
  updated: number
  unknown: number
  /** The newest finish of a member; counted when asked for. */
  readonly finishedAt: number
}

/**
 * The counts of an update's members from what is kept. `pages` says, for
 * each of its timeline pages, whether it can submit its failed members
 * again.
 */
export function keptCounts(
  db: Executor,
  id: string,
  pages: { id: string; retry: number }[],
): KeptCounts | undefined {
  const [p] = db.all<{
    total: number
    complete: number
    complete_added: number
    complete_updated: number
    partial: number
    partial_added: number
    partial_updated: number
    failed: number
    pending: number
  }>(sql`SELECT * FROM update_progress WHERE update_id = ${id}`)
  if (!p) return
  // Failed members that only saw their source gone again are `known`.
  const [known] = db.all<{
    n: number
    added: number
    updated: number
  }>(sql`
    SELECT count(*) AS n,
      count(*) FILTER (WHERE m.added = 1) AS added,
      count(*) FILTER (WHERE m.added = 0) AS updated
    FROM update_members m
    JOIN captures c ON c.id = m.capture_id
    JOIN collections a ON a.id = c.collection_id
    WHERE m.update_id = ${id} AND m.state = 'failed'
      AND ${sql.raw(knownGoneSQL('c', 'a'))}`)
  // A member can be retried when a listing of it can submit it again (its
  // page, or an item of the update) and its source exists, or it misses
  // media; only failed and partial members can.
  const [retry] = db.all<{ n: number | null }>(sql`
    WITH pages(id, retry) AS (
      SELECT value ->> '$.id', value ->> '$.retry'
      FROM json_each(${JSON.stringify(pages)})
    ),
    captured AS (
      SELECT c.id,
        max((CASE WHEN s.update_id = ${id}
              THEN EXISTS (SELECT 1 FROM captures i
                JOIN library l ON l.collection_id = i.collection_id
                WHERE i.id = s.capture_id)
              ELSE p.retry END
            AND c.state = 'failed' AND a.source_state IS NULL)
          OR ${missingMediaSQL}) AS retryable
      FROM update_members m
      JOIN captures c ON c.id = m.capture_id
      JOIN collections a ON a.id = c.collection_id
      JOIN submissions s ON s.capture_id = c.id
      LEFT JOIN pages p ON p.id = s.parent_submission
        AND s.idem_key LIKE 'related:%'
      WHERE m.update_id = ${id} AND m.state IN ('failed', 'partial')
        AND (s.update_id = ${id} OR p.id IS NOT NULL)
      GROUP BY c.id
    )
    SELECT sum(retryable) AS n FROM captured`)
  const knownAdded = known?.added ?? 0
  const knownUpdated = known?.updated ?? 0
  const knownN = known?.n ?? 0
  const finished = p.complete + p.partial + knownN
  const added = p.complete_added + p.partial_added + knownAdded
  const updated = p.complete_updated + p.partial_updated + knownUpdated
  return {
    total: p.total,
    complete: p.complete,
    partial: p.partial,
    failed: p.failed - knownN,
    pending: p.pending,
    known: knownN,
    retryable: retry?.n ?? 0,
    added,
    updated,
    unknown: finished - added - updated,
    get finishedAt() {
      return (
        db.all<{ at: number | null }>(sql`
          SELECT max(c.finished_at) AS at FROM update_members m
          JOIN captures c ON c.id = m.capture_id WHERE m.update_id = ${id}`)[0]
          ?.at ?? 0
      )
    },
  }
}

/**
 * Compare the kept members of an update with the sources, counted from
 * scratch; what differs, as text (nothing when exact).
 */
export function verifyMembers(db: Executor, id: string): string[] {
  if (!isTracked(db, id)) return ['progress is not kept']
  const problems: string[] = []
  const pages = chainPages(db, id).toSorted()
  const kept = db
    .all<{ id: string }>(
      sql`SELECT page_id AS id FROM update_pages WHERE update_id = ${id}`,
    )
    .map((row) => row.id)
    .toSorted()
  if (JSON.stringify(pages) !== JSON.stringify(kept))
    problems.push(`pages: kept ${kept.length}, sources ${pages.length}`)
  const sources = new Map(
    population(db, id).map((row) => [row.collection, row]),
  )
  const rows = db.all<Row>(sql`
    SELECT collection_id AS collection, capture_id AS capture, state, added
    FROM update_members WHERE update_id = ${id}`)
  for (const row of rows) {
    const source = sources.get(row.collection)
    if (!source) problems.push(`member ${row.collection} is not a member`)
    else if (!sameRow(source, row))
      problems.push(
        `member ${row.collection}: kept ${JSON.stringify(row)}, sources ${JSON.stringify(source)}`,
      )
    sources.delete(row.collection)
  }
  for (const missing of sources.keys())
    problems.push(`member ${missing} is missing`)
  return problems
}
