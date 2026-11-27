import { Buffer } from 'node:buffer'
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  like,
  notLike,
  or,
  sql,
} from 'drizzle-orm'
import { newId } from '#db/id.ts'
import {
  accountSelections,
  assets,
  captureRunning,
  captures,
  captureTargets,
  collections,
  jobs,
  library,
  revisions,
  submissions,
  updates,
} from '#db/schema.ts'
import { inJson } from '#db/sql.ts'
import { AppError } from '#errors.ts'
import { readJobControl } from '#jobs/control.ts'
import { memberAccounts, type MemberAccount } from './accounts.ts'
import {
  DEFAULT_OPTIONS,
  publicOptions,
  storedOptions,
  type CaptureOptions,
} from './options.ts'
import { keepRecord, keptRecord } from './record-cache.ts'
import { detailKey, dropSummaries, loadSummaries } from './record-summaries.ts'
import { continuePages, type StoredTarget } from './related.ts'
import {
  relationProgresses,
  relationsDone,
  type RelationProgress,
} from './relations.ts'
import {
  failedPages,
  isRetryableList,
  isRetryablePage,
  missingMedia,
  missingMediaSQL,
  pagesMissingMedia,
  type FailedPage,
} from './retry-units.ts'
import {
  knownGone,
  knownGoneSQL,
  RECHECK_KEY,
  type SourceState,
} from './source-state.ts'
import { submit, type Job } from './submit.ts'
import type { Executor } from '#db/client.ts'
import type { RelationList } from '#platforms/platform.ts'
import type { CaptureContext } from './context.ts'
import type { Payload } from './payload.ts'

const RECORD_PAGE = 30
const MEMBER_PAGE = 50
const MAX_DEPTH = 1000
// Keys of submissions made by the pipeline itself, not by a request.
const INTERNAL_KEYS = [
  'related:%',
  'related-expand:%',
  'batch:%',
  'retried:%',
  `${RECHECK_KEY}%`,
]

type Submission = typeof submissions.$inferSelect
type Capture = typeof captures.$inferSelect

/** The account selected for a platform, or '' for anonymous. */
export function selectedConnection(db: Executor, adapterId: string): string {
  return (
    db
      .select({ id: accountSelections.connectionId })
      .from(accountSelections)
      .where(eq(accountSelections.adapterId, adapterId))
      .get()?.id ?? ''
  )
}

/** Save a link with the account currently selected for its platform. */
export function captureURL(
  ctx: CaptureContext,
  raw: string,
  key?: string,
  options: CaptureOptions = DEFAULT_OPTIONS,
  refetch = false,
): Job {
  const { platform, target } = ctx.platforms.resolve(raw)
  return submit(ctx, {
    url: target.url,
    input: raw,
    connectionId:
      selectedConnection(ctx.db, platform.description.adapterId) || undefined,
    refetch,
    key,
    options,
  })
}

// --- Cursors --------------------------------------------------------------

export function encodeCursor(at: Date, id: string, filter: string): string {
  return Buffer.from(
    JSON.stringify({ t: at.getTime(), id, f: filter }),
  ).toString('base64url')
}

export function decodeCursor(
  cursor: string,
  filter: string,
): { at: Date; id: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (
      value?.f === filter &&
      Number.isSafeInteger(value.t) &&
      typeof value.id === 'string'
    )
      return { at: new Date(value.t), id: value.id }
  } catch {}
  throw new AppError('invalid_cursor')
}

// --- Progress -------------------------------------------------------------

export interface MemberProgress {
  total: number
  complete: number
  partial: number
  failed: number
  pending: number
  /**
   * Failed only by saying again what they are known to be, deleted or
   * suspended: no anomaly, and nothing to retry.
   */
  known: number
  done: boolean
  /**
   * Finished members new to the library and ones already saved; absent
   * while any finished member predates recording it.
   */
  added?: number
  updated?: number
}

export type Page = {
  submission: Submission
  capture: Capture
  /** What the page listed, once fetched. */
  targets: StoredTarget[] | null
}

export interface CollectionProgress extends MemberProgress {
  stopped: boolean
  next: string
  maxBatch: number
  error: '' | 'partial_pages'
  /**
   * What a retry would fetch again: failed members, members and later pages
   * missing media, and failed pages.
   */
  retryable: number
  pages: Page[]
  failedPages: FailedPage[]
  /** Pages after the first missing media. */
  pagesMissingMedia: string[]
}

/** Each record's pages: its submission and the continuation chain, in order. */
export function pageChains(db: Executor, roots: string[]): Map<string, Page[]> {
  const chains = new Map(roots.map((root) => [root, [] as Page[]]))
  if (!roots.length) return chains
  const links = db.all<{ root: string; id: string }>(sql`
    WITH RECURSIVE chain(root, id, depth) AS (
      SELECT value, value, 1 FROM json_each(${JSON.stringify(roots)})
      UNION ALL
      SELECT chain.root, s.next_submission, chain.depth + 1
      FROM chain JOIN submissions s ON s.id = chain.id
      WHERE s.next_submission IS NOT NULL AND chain.depth < ${MAX_DEPTH}
    )
    SELECT root, id FROM chain ORDER BY depth`)
  const rows = new Map(
    db
      .select({
        submission: submissions,
        capture: captures,
        targets: captureTargets.targets,
      })
      .from(submissions)
      .innerJoin(captures, eq(captures.id, submissions.captureId))
      .leftJoin(captureTargets, eq(captureTargets.captureId, captures.id))
      .where(inJson(submissions.id, [...new Set(links.map((link) => link.id))]))
      .all()
      .map((row) => [row.submission.id, row]),
  )
  const broken = new Set<string>()
  for (const { root, id } of links) {
    const row = rows.get(id)
    if (!row) broken.add(root)
    if (!broken.has(root)) chains.get(root)!.push(row!)
  }
  return chains
}

export const isPending = (state: string) =>
  state === 'queued' || state === 'downloading'

/**
 * A member's listing on a page and its capture: only what member lists and
 * retries read, since a profile's pages can list tens of thousands.
 */
export interface Listing {
  submission: Pick<
    Submission,
    'id' | 'parentSubmission' | 'updateId' | 'libraryAdded'
  >
  capture: MemberCapture
}

export type MemberCapture = Pick<
  Capture,
  'id' | 'state' | 'createdAt' | 'finishedAt' | 'collectionId' | 'error'
>

export function memberSubmissions(db: Executor, pageIds: string[]): Listing[] {
  if (!pageIds.length) return []
  return db
    .select({
      submission: {
        id: submissions.id,
        parentSubmission: submissions.parentSubmission,
        updateId: submissions.updateId,
        libraryAdded: submissions.libraryAdded,
      },
      capture: {
        id: captures.id,
        state: captures.state,
        createdAt: captures.createdAt,
        finishedAt: captures.finishedAt,
        collectionId: captures.collectionId,
        error: captures.error,
      },
    })
    .from(submissions)
    .innerJoin(captures, eq(captures.id, submissions.captureId))
    .where(
      and(
        inJson(submissions.parentSubmission, pageIds),
        like(submissions.idemKey, 'related:%'),
      ),
    )
    .all()
}

type MemberCounts = Pick<
  CollectionProgress,
  | 'complete'
  | 'partial'
  | 'failed'
  | 'pending'
  | 'known'
  | 'retryable'
  | 'added'
  | 'updated'
>

/**
 * Members of each record by state, counted in SQL: a profile can have tens
 * of thousands. A member listed on several pages counts once, as new when
 * any of its listings saved it as new.
 */
function memberCounts(
  db: Executor,
  chains: Map<string, Page[]>,
): Map<string, MemberCounts> {
  const counts = new Map<string, MemberCounts>()
  const additions = new Map<
    string,
    { added: number; updated: number; unknown: number }
  >()
  for (const root of chains.keys()) {
    counts.set(root, {
      complete: 0,
      partial: 0,
      failed: 0,
      pending: 0,
      known: 0,
      retryable: 0,
      added: 0,
      updated: 0,
    })
    additions.set(root, { added: 0, updated: 0, unknown: 0 })
  }
  const pages = [...chains].flatMap(([root, list]) =>
    list.map((page) => ({
      id: page.submission.id,
      root,
      retry: isRetryablePage(page) ? 1 : 0,
    })),
  )
  if (!pages.length) return counts
  // Retryable: failed members of pages that can submit them again, whose
  // source still exists, and members missing media.
  const rows = db.all<{
    root: string
    state: string
    n: number
    retryable: number
    added: number
    updated: number
  }>(sql`
    WITH members AS (
      SELECT p.value ->> '$.root' AS root, c.id AS id,
        CASE WHEN ${sql.raw(knownGoneSQL('c', 'a'))} THEN 'known'
          ELSE c.state END AS state,
        max((p.value ->> '$.retry' AND c.state = 'failed'
          AND a.source_state IS NULL) OR ${missingMediaSQL}) AS retryable,
        max(s.library_added) AS added
      FROM json_each(${JSON.stringify(pages)}) p
      JOIN submissions s ON s.parent_submission = p.value ->> '$.id'
      JOIN captures c ON c.id = s.capture_id
      JOIN collections a ON a.id = c.collection_id
      WHERE s.idem_key LIKE 'related:%'
      GROUP BY 1, 2
    )
    SELECT root, state, count(*) AS n, sum(retryable) AS retryable,
      count(*) FILTER (WHERE added = 1) AS added,
      count(*) FILTER (WHERE added = 0) AS updated
    FROM members
    GROUP BY 1, 2`)
  for (const row of rows) {
    const count = counts.get(row.root)!
    const addition = additions.get(row.root)!
    switch (row.state) {
      case 'complete':
      case 'partial': {
        count[row.state] += row.n
        addition.added += row.added
        addition.updated += row.updated
        addition.unknown += row.n - row.added - row.updated
        break
      }
      case 'failed': {
        count.failed += row.n
        break
      }
      // Already saved, and checked: new or updated as the finished are.
      case 'known': {
        count.known += row.n
        addition.added += row.added
        addition.updated += row.updated
        addition.unknown += row.n - row.added - row.updated
        break
      }
      default:
        if (isPending(row.state)) count.pending += row.n
    }
    count.retryable += row.retryable
  }
  for (const [root, count] of counts) {
    const { added, updated, unknown } = additions.get(root)!
    if (unknown) {
      delete count.added
      delete count.updated
    } else Object.assign(count, { added, updated })
  }
  return counts
}

function progressOf(
  pages: Page[],
  counts: MemberCounts,
  missing: string[],
): CollectionProgress {
  const urls = new Set<string>()
  for (const page of pages)
    for (const target of page.targets ?? []) urls.add(target.url)
  const first = pages[0]?.capture
  const last = pages.at(-1)?.capture
  const pagePending = pages.some(
    (p) =>
      isPending(p.capture.state) ||
      (p.submission.relatedState === 'pending' && p.capture.state !== 'failed'),
  )
  const done =
    first?.state === 'failed' ||
    ((first?.state === 'complete' || first?.state === 'partial') &&
      !pagePending &&
      counts.pending === 0)
  const pageFailed = pages.some(
    (p) =>
      p.capture.state === 'failed' ||
      p.capture.state === 'partial' ||
      p.submission.relatedState === 'failed',
  )
  const failed = failedPages(pages)
  return {
    total: urls.size,
    ...counts,
    retryable: counts.retryable + failed.length + missing.length,
    failedPages: failed,
    pagesMissingMedia: missing,
    done,
    stopped: pages.some((p) => p.submission.collectionStopped),
    next: last?.nextPageCursor ?? '',
    maxBatch: last?.maxBatchSize ?? 0,
    error: pageFailed ? 'partial_pages' : '',
    pages,
  }
}

/** Progress of several collection records at once, by record id. */
export function collectionProgresses(
  db: Executor,
  roots: string[],
): Map<string, CollectionProgress> {
  const chains = pageChains(db, roots)
  const counts = memberCounts(db, chains)
  const missing = pagesMissingMedia(db, chains)
  return new Map(
    [...chains].map(([root, pages]) => [
      root,
      progressOf(pages, counts.get(root)!, missing.get(root)!),
    ]),
  )
}

export function collectionProgress(
  db: Executor,
  root: string,
): CollectionProgress {
  return collectionProgresses(db, [root]).get(root)!
}

/**
 * Why captures fell short, counted per capture: `captureIds` and the members
 * of `pageIds`. Each reason in `extra` counts once more.
 */
export function failureReasons(
  db: Executor,
  captureIds: string[],
  pageIds: string[],
  extra: string[],
) {
  const rows = db.all<{ reason: string; count: number }>(sql`
    WITH ids(id) AS (
      SELECT value FROM json_each(${JSON.stringify(captureIds)})
      UNION
      SELECT s.capture_id FROM submissions s
      WHERE s.parent_submission IN
          (SELECT value FROM json_each(${JSON.stringify(pageIds)}))
        AND s.idem_key LIKE 'related:%'
    ),
    reasons(reason, capture) AS (
      -- Saying again what the source is known to be is no failure.
      SELECT c.error, c.id FROM ids JOIN captures c ON c.id = ids.id
      JOIN collections a ON a.id = c.collection_id
      WHERE c.state = 'failed'
        AND NOT coalesce(${sql.raw(knownGoneSQL('c', 'a'))}, 0)
      UNION ALL
      SELECT a.error, a.capture_id FROM ids JOIN assets a ON a.capture_id = ids.id
      WHERE a.state = 'failed'
      UNION ALL
      SELECT w.value, c.id FROM ids JOIN captures c ON c.id = ids.id
      JOIN revisions r ON r.id = c.revision_id,
        json_each(r.payload, '$.warnings') w
      WHERE c.state = 'partial'
    )
    SELECT reason, count(DISTINCT capture) AS count FROM reasons
    WHERE reason <> ''
    GROUP BY reason`)
  const counts = new Map(rows.map((row) => [row.reason, row.count]))
  for (const reason of extra)
    if (reason) counts.set(reason, (counts.get(reason) ?? 0) + 1)
  return [...counts]
    .map(([reason, count]) => ({ reason, count }))
    .toSorted((a, b) => b.count - a.count || (a.reason < b.reason ? -1 : 1))
}

/** Why a collection record's pages and members fell short. */
export function collectionReasons(db: Executor, pages: Page[]) {
  return failureReasons(
    db,
    pages.map((p) => p.capture.id),
    pages.map((p) => p.submission.id),
    listingErrors(db, pages),
  )
}

/**
 * Why pages could not list their members; not for a page whose capture
 * only saw a known state again, which is no failure.
 */
export function listingErrors(db: Executor, pages: Page[]): string[] {
  const failed = pages.filter((p) => p.submission.relatedState === 'failed')
  const known = knownCaptures(
    db,
    failed.map((p) => p.capture.id),
  )
  return failed
    .filter((p) => !known.has(p.capture.id))
    .map((p) => p.submission.relatedError)
}

// --- Waiting --------------------------------------------------------------

/** Why a queued capture is not being fetched yet. */
export type CaptureWait = 'queue' | 'retry' | 'paused' | 'rate_limit'

/**
 * Queued captures whose capture job is not running: it waits for a free slot
 * in the capture queue (or for its account to be free), for the backoff
 * after a failed attempt, or for the end of a rate limit of the API it asks
 * (`#jobs/rate-limits.ts`). A queued capture missing here is being fetched:
 * the capture state stays `queued` until the fetch is stored.
 */
export function captureWaits(
  db: Executor,
  captureIds: string[],
  now = Date.now(),
): Map<string, CaptureWait> {
  if (!captureIds.length) return new Map()
  // Paused: its update is, or the owner paused all background work.
  const allPaused = readJobControl(db).paused
  return new Map(
    db
      .select({
        ref: jobs.ref,
        attempt: jobs.attempt,
        state: jobs.state,
        rateScope: jobs.rateScope,
        runAt: jobs.runAt,
      })
      .from(jobs)
      .where(
        and(
          eq(jobs.type, 'capture'),
          inArray(jobs.state, ['available', 'paused']),
          inJson(jobs.ref, captureIds),
        ),
      )
      .all()
      // A busy account gives its attempt back, so only failures count here.
      .map((job): [string, CaptureWait] => [
        job.ref,
        allPaused || job.state === 'paused'
          ? 'paused'
          : job.rateScope && job.runAt.getTime() > now
            ? 'rate_limit'
            : job.attempt > 0
              ? 'retry'
              : 'queue',
      ]),
  )
}

/**
 * How many captures of a collection record's pages (the pages and their
 * members) wait for the end of a rate limit. Read from the few jobs that
 * wait for one.
 */
export function rateLimitedMembers(
  db: Executor,
  pageIds: string[],
  now = Date.now(),
): number {
  if (!pageIds.length) return 0
  const pages = JSON.stringify(pageIds)
  return (
    db.get<{ n: number }>(sql`
      SELECT count(DISTINCT j.ref) AS n FROM jobs j
      JOIN submissions s ON s.capture_id = j.ref
      WHERE j.rate_scope IS NOT NULL AND j.type = 'capture'
        AND j.state <> 'running' AND j.run_at > ${now}
        AND (s.id IN (SELECT value FROM json_each(${pages}))
          OR (s.parent_submission IN (SELECT value FROM json_each(${pages}))
            AND s.idem_key LIKE 'related:%'))`)?.n ?? 0
  )
}

export const queuedIds = (list: Pick<Capture, 'id' | 'state'>[]) =>
  list.filter((c) => c.state === 'queued').map((c) => c.id)

// --- Records --------------------------------------------------------------

export interface CaptureRecord {
  id: string
  jobId: string
  collectionId: string
  saved: boolean
  url: string
  /** A profile's username and display name, when a stored version has them. */
  handle?: string
  name?: string
  input: string
  platform: string
  kind: string
  state: string
  /** Set while the capture is queued and not being fetched yet. */
  waiting?: CaptureWait
  error: string
  createdAt: Date
  finishedAt: Date | null
  media: { total: number; ready: number; failed: number }
  done: boolean
  members?: MemberProgress
  /** A record without members that saved its target: whether it was new. */
  added?: boolean
  /** Failed only by saying again what its target is known to be. */
  sourceState?: SourceState
  stopped?: boolean
  /** An update the owner paused (`pauseUpdate`). */
  paused?: boolean
  /** Unfinished while all background work is paused (管理员面板). */
  pausedAll?: boolean
  /** `capped`: the post cap stopped `until_existing`; it can continue. */
  pages?: {
    more: boolean
    more1000: boolean
    capped: boolean
    failed: boolean
  }
  /** Parts a retry would fetch again, each counted once. */
  retryable: number
  /** Its own capture is missing media a retry would download. */
  mediaRetryable: boolean
  /** The following and followers lists it asked for (抓关系网). */
  relations?: RelationProgress[]
  /** The options it ran with; none on rows from before they were kept. */
  options?: CaptureOptions
}

/**
 * Requests that are records of their own. The items of an update are not:
 * the update is their record, but they can still be looked up by id, e.g.
 * to continue a profile's pages.
 */
export function recordFilterSQL(items = false) {
  return and(
    isNull(submissions.parentSubmission),
    sql`${submissions.input} <> ''`,
    ...INTERNAL_KEYS.map((key) => notLike(submissions.idemKey, key)),
    ...(items ? [] : [isNull(submissions.updateId)]),
  )
}

export function recordRows(
  db: Executor,
  where: ReturnType<typeof and>,
  limit: number,
  items = false,
) {
  return db
    .select({
      submission: submissions,
      capture: captures,
      collection: collections,
      saved:
        sql<boolean>`EXISTS (SELECT 1 FROM ${library} WHERE ${library.collectionId} = ${collections.id})`.mapWith(
          Boolean,
        ),
    })
    .from(submissions)
    .innerJoin(captures, eq(captures.id, submissions.captureId))
    .innerJoin(collections, eq(collections.id, captures.collectionId))
    .where(and(recordFilterSQL(items), where))
    .orderBy(desc(submissions.createdAt), desc(submissions.id))
    .limit(limit)
    .all()
}

type RecordRow = ReturnType<typeof recordRows>[number]

/** Records for rows, with a fixed number of queries for any number of rows. */
export function toRecords(db: Executor, rows: RecordRow[]): CaptureRecord[] {
  const media = new Map(
    (rows.length
      ? db
          .select({
            captureId: assets.captureId,
            total: sql<number>`count(*)`.mapWith(Number),
            ready:
              sql<number>`count(*) FILTER (WHERE ${assets.state} = 'ready')`.mapWith(
                Number,
              ),
            failed:
              sql<number>`count(*) FILTER (WHERE ${assets.state} = 'failed')`.mapWith(
                Number,
              ),
          })
          .from(assets)
          .where(
            inJson(
              assets.captureId,
              rows.map((row) => row.capture.id),
            ),
          )
          .groupBy(assets.captureId)
          .all()
      : []
    ).map(({ captureId, ...counts }) => [captureId, counts]),
  )
  const progresses = collectionProgresses(
    db,
    rows
      .filter(
        (row) =>
          row.capture.isCollection && row.submission.relatedState !== 'none',
      )
      .map((row) => row.submission.id),
  )
  const waits = captureWaits(db, queuedIds(rows.map((row) => row.capture)))
  const missing = missingMedia(
    db,
    rows.map((row) => row.capture.id),
  )
  const relations = relationProgresses(
    db,
    rows.map((row) => row.submission.id),
  )
  const accounts = memberAccounts(
    db,
    rows
      .filter((row) => row.collection.kind === 'profile')
      .map((row) => row.collection.id),
  )
  return rows.map(({ submission, capture, collection, saved }) => {
    const { handle, name } = accounts.get(collection.id) ?? {}
    const record: CaptureRecord = {
      id: submission.id,
      jobId: capture.id,
      collectionId: collection.id,
      saved: !!saved,
      url: collection.url,
      ...(handle ? { handle } : {}),
      ...(name ? { name } : {}),
      input: submission.input,
      platform: collection.platform,
      kind: collection.kind,
      state: capture.state,
      error: capture.error,
      createdAt: submission.createdAt,
      finishedAt: capture.finishedAt,
      media: media.get(capture.id) ?? { total: 0, ready: 0, failed: 0 },
      done: ['complete', 'partial', 'failed'].includes(capture.state),
      retryable: missing.has(capture.id) ? 1 : 0,
      mediaRetryable: missing.has(capture.id),
    }
    const waiting = waits.get(capture.id)
    if (waiting) record.waiting = waiting
    const known = knownGone(capture, collection)
    if (known) record.sourceState = known
    const progress = progresses.get(submission.id)
    if (progress) {
      const {
        pages,
        stopped,
        next,
        maxBatch,
        error,
        retryable,
        failedPages: _,
        pagesMissingMedia: __,
        ...members
      } = progress
      record.members = members
      record.retryable += retryable
      record.stopped = stopped
      record.done = members.done || stopped
      if (record.done && !stopped)
        record.pages = {
          more: !!next,
          more1000: !!next && maxBatch >= 1000,
          capped: !!pages.at(-1)?.submission.timelineCapped,
          // 重试本页 also reads again a page that came with a note (a
          // protected account's posts it may not see), once it may.
          failed:
            error === 'partial_pages' ||
            capture.state === 'failed' ||
            capture.state === 'partial' ||
            !!capture.error,
        }
    } else if (
      (capture.state === 'complete' || capture.state === 'partial') &&
      submission.libraryAdded !== null
    )
      record.added = submission.libraryAdded
    if (submission.captureOptions)
      record.options = publicOptions(submission.captureOptions)
    const lists = relations.get(submission.id)
    if (lists) {
      record.relations = lists.map((list) => ({
        ...list,
        retryable: isRetryableList(list.state, {
          captureState: capture.state,
          stopped: submission.collectionStopped,
        }),
      }))
      record.retryable += record.relations.filter((l) => l.retryable).length
      // The lists are fetched after the profile; the record runs until then.
      record.done &&= relationsDone(lists)
    }
    return record
  })
}

const toRecord = (db: Executor, row: RecordRow) => toRecords(db, [row])[0]!

export const RECORD_PAGE_SIZE = RECORD_PAGE

/** Up to `limit` request records older than `after`, newest first. */
export function requestRecords(
  db: Executor,
  after: { at: Date; id: string } | undefined,
  limit: number,
): CaptureRecord[] {
  const rows = recordRows(
    db,
    after
      ? or(
          sql`${submissions.createdAt} < ${after.at.getTime()}`,
          and(
            sql`${submissions.createdAt} = ${after.at.getTime()}`,
            sql`${submissions.id} < ${after.id}`,
          ),
        )
      : undefined,
    limit,
  )
  return recordsOf(db, rows)
}

/**
 * Records for rows. Finished records are written down
 * (`record-summaries.ts`); those kept on a read thread are not counted
 * again either.
 */
function recordsOf(db: Executor, rows: RecordRow[]): CaptureRecord[] {
  const found = new Map<string, CaptureRecord>()
  const summaries = loadSummaries(
    db,
    rows.map((row) => row.submission.id),
  )
  for (const row of rows) {
    const id = row.submission.id
    const written = summaries.get(id)
    const record =
      written?.stamp === rowStamp(row)
        ? written.record
        : keptRecord<CaptureRecord>(id, rowStamp(row))
    if (record) found.set(id, record)
  }
  const counted = new Map(
    toRecords(
      db,
      rows.filter((row) => !found.has(row.submission.id)),
    ).map((record) => [record.id, record]),
  )
  return rows.map((row) => {
    const id = row.submission.id
    const record = found.get(id) ?? counted.get(id)!
    if (!found.has(id)) keepRecord(id, rowStamp(row), record, !record.done)
    return record
  })
}

/** What of a record's own rows a kept record must still match. */
export const rowStamp = (row: RecordRow) =>
  JSON.stringify([
    row.capture.state,
    row.capture.finishedAt?.getTime(),
    row.submission.relatedState,
    row.submission.collectionStopped,
    row.saved,
  ])

export function recordRow(db: Executor, id: string) {
  const row = recordRows(db, eq(submissions.id, id), 1, true)[0]
  if (!row) throw new AppError('not_found')
  return row
}

export interface CaptureRecordDetail extends CaptureRecord {
  warnings: string[]
  mediaItems: {
    position: number
    kind: string
    purpose: string
    state: string
    error: string
  }[]
  reasons: { reason: string; count: number }[]
}

export function recordDetail(db: Executor, id: string): CaptureRecordDetail {
  const row = recordRow(db, id)
  // A finished record's detail is written down with it.
  const written = loadSummaries<CaptureRecordDetail>(db, [detailKey(id)]).get(
    detailKey(id),
  )
  if (written?.stamp === rowStamp(row)) return written.record
  return countRecordDetail(db, row)
}

/** A record's detail counted now. */
export function countRecordDetail(
  db: Executor,
  row: RecordRow,
  known?: CaptureRecord,
): CaptureRecordDetail {
  const id = row.submission.id
  const record = known ?? recordsOf(db, [row])[0]!
  const revision = row.capture.revisionId
    ? db
        .select({ payload: revisions.payload })
        .from(revisions)
        .where(eq(revisions.id, row.capture.revisionId))
        .get()
    : undefined
  return {
    ...record,
    warnings: (revision?.payload as Payload | undefined)?.warnings ?? [],
    mediaItems: db
      .select({
        position: assets.position,
        kind: assets.kind,
        purpose: assets.purpose,
        state: assets.state,
        error: assets.error,
      })
      .from(assets)
      .where(eq(assets.captureId, row.capture.id))
      .orderBy(asc(assets.position))
      .limit(500)
      .all(),
    reasons: record.members
      ? collectionReasons(db, collectionProgress(db, id).pages)
      : failureReasons(db, [row.capture.id], [], []),
  }
}

type MemberFilter = (state: string, added: boolean | null) => boolean
const isFinished = (state: string) =>
  state === 'complete' || state === 'partial'

/**
 * Member filters. `added` and `updated` take finished members only, as the
 * record's counts do: a running one is neither yet, a failed one saved
 * nothing. Members from before `library_added` was recorded are in neither.
 */
const MEMBER_FILTERS: Record<string, MemberFilter> = {
  '': () => true,
  added: (state, added) =>
    (isFinished(state) || state === 'known') && added === true,
  updated: (state, added) =>
    (isFinished(state) || state === 'known') && added === false,
  problem: (state) =>
    state === 'failed' || state === 'partial' || state === 'skipped',
  pending: isPending,
  failed: (state) => state === 'failed',
  partial: (state) => state === 'partial',
  complete: (state) => state === 'complete',
}

export interface CaptureMember {
  jobId: string
  collectionId: string
  saved: boolean
  url: string
  state: string
  waiting?: CaptureWait
  error: string
  createdAt: Date
  gone: boolean
  /** Failed only by saying again what its source is known to be. */
  sourceState?: SourceState
  reasons: string[]
  /** Whether a retry would fetch it again (or its missing media). */
  retryable: boolean
  /** A profile's following or followers list rather than a capture. */
  list?: RelationList
  /** The collection's kind: `post` or `profile`. */
  kind?: string
  /** A profile's (or the list's profile's) username, without `@`. */
  handle?: string
  /** A profile's display name. */
  name?: string
  /** The saved collection with content to open for it (`memberAccounts`). */
  libraryId?: string
}

/** A member's name and link, leaving out what is unknown. */
export function accountFields(
  account: MemberAccount | undefined,
): Pick<CaptureMember, 'handle' | 'name' | 'libraryId'> {
  return {
    ...(account?.handle ? { handle: account.handle } : {}),
    ...(account?.name ? { name: account.name } : {}),
    ...(account?.libraryId ? { libraryId: account.libraryId } : {}),
  }
}

export function recordMembers(
  db: Executor,
  id: string,
  state: string,
  cursor?: string,
): { items: CaptureMember[]; next?: string } {
  recordRow(db, id)
  const pages = pageChains(db, [id]).get(id)!
  const resubmit = new Set(
    pages.filter(isRetryablePage).map((p) => p.submission.id),
  )
  return memberPage(
    db,
    `members:${id}`,
    state,
    cursor,
    memberSubmissions(
      db,
      pages.map((p) => p.submission.id),
    ),
    [],
    (listing) => resubmit.has(listing.submission.parentSubmission ?? ''),
  )
}

/**
 * A page of members by state, oldest first. A capture listed several times
 * is one member, new if any listing was new (as `memberCounts` counts it).
 * `extra` are members that are not captures, such as a profile's lists.
 * A failed capture is retryable when one of its listings can submit it
 * again (`resubmits`) and its source still exists.
 */
export function memberPage(
  db: Executor,
  key: string,
  state: string,
  cursor: string | undefined,
  listings: Listing[],
  extra: CaptureMember[] = [],
  resubmits: (listing: Listing) => boolean = () => false,
): { items: CaptureMember[]; next?: string } {
  const wanted = Object.hasOwn(MEMBER_FILTERS, state)
    ? MEMBER_FILTERS[state]
    : undefined
  if (!wanted) throw new AppError('invalid_filter')
  const filter = `${key}:${state}`
  const after = cursor ? decodeCursor(cursor, filter) : undefined
  const listed = new Map<
    string,
    { capture: MemberCapture; added: boolean | null }
  >()
  const resubmitted = new Set<string>()
  for (const listing of listings) {
    const { capture, submission } = listing
    const seen = listed.get(capture.id)
    const added = submission.libraryAdded
    if (!seen) listed.set(capture.id, { capture, added })
    else if (added !== null && seen.added !== true) seen.added = added
    if (capture.state === 'failed' && resubmits(listing))
      resubmitted.add(capture.id)
  }
  type Entry = {
    id: string
    createdAt: Date
    capture?: MemberCapture
    view?: CaptureMember
  }
  const known = knownCaptures(
    db,
    [...listed.values()].flatMap((m) =>
      m.capture.state === 'failed' ? [m.capture.id] : [],
    ),
  )
  const members = [
    ...[...listed.values()]
      .filter((m) =>
        wanted(known.has(m.capture.id) ? 'known' : m.capture.state, m.added),
      )
      .map((m): Entry => ({
        id: m.capture.id,
        createdAt: m.capture.createdAt,
        capture: m.capture,
      })),
    ...extra
      .filter((m) => wanted(m.state, null))
      .map((m): Entry => ({ id: m.jobId, createdAt: m.createdAt, view: m })),
  ]
    .toSorted(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1),
    )
    .filter(
      (c) =>
        !after ||
        c.createdAt.getTime() > after.at.getTime() ||
        (c.createdAt.getTime() === after.at.getTime() && c.id > after.id),
    )
  const page = members.slice(0, MEMBER_PAGE)
  const views = new Map(
    memberViews(
      db,
      page.flatMap((m) => (m.capture ? [m.capture] : [])),
      resubmitted,
    ).map((view) => [view.jobId, view]),
  )
  const items = page.map((m) => m.view ?? views.get(m.id)!)
  const last = page.at(-1)
  return {
    items,
    ...(members.length > MEMBER_PAGE && last
      ? { next: encodeCursor(last.createdAt, last.id, filter) }
      : {}),
  }
}

/**
 * The notes of a record's complete captures (see `noted` in finalize): of
 * an update's items, or of the record's own capture, with their links.
 */
export function recordNotes(
  db: Executor,
  id: string,
  update: boolean,
): { url: string; note: string }[] {
  return db.all<{ url: string; note: string }>(sql`
    SELECT a.url, c.error AS note FROM submissions s
    JOIN captures c ON c.id = s.capture_id
    JOIN collections a ON a.id = c.collection_id
    WHERE ${update ? sql`s.update_id = ${id}` : sql`s.id = ${id}`}
      AND c.state = 'complete' AND c.error <> ''
    ORDER BY s.created_at, s.id
    LIMIT 50`)
}

/** Of these failed captures, the ones that only saw a known state again. */
export function knownCaptures(db: Executor, ids: string[]): Set<string> {
  return new Set(knownStates(db, ids).keys())
}

/** Of these failed captures, the known state each only saw again. */
export function knownStates(
  db: Executor,
  ids: string[],
): Map<string, SourceState> {
  if (!ids.length) return new Map()
  return new Map(
    db
      .all<{ id: string; state: SourceState }>(
        sql`
        SELECT c.id, a.source_state AS state FROM captures c
        JOIN collections a ON a.id = c.collection_id
        WHERE c.id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))
          AND ${sql.raw(knownGoneSQL('c', 'a'))}`,
      )
      .map((row) => [row.id, row.state]),
  )
}

/** Captures as members of a record, with why each fell short. */
function memberViews(
  db: Executor,
  page: MemberCapture[],
  resubmitted: Set<string>,
): CaptureMember[] {
  const ids = page.map((c) => c.id)
  const targets = new Map(
    (page.length
      ? db
          .select({
            id: collections.id,
            url: collections.url,
            kind: collections.kind,
            sourceState: collections.sourceState,
            sourceStateAt: collections.sourceStateAt,
            saved:
              sql<boolean>`EXISTS (SELECT 1 FROM ${library} WHERE ${library.collectionId} = ${collections.id})`.mapWith(
                Boolean,
              ),
          })
          .from(collections)
          .where(
            inJson(
              collections.id,
              page.map((c) => c.collectionId),
            ),
          )
          .all()
      : []
    ).map((row) => [row.id, row]),
  )
  const reasons = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]))
  if (page.length)
    for (const row of db.all<{ capture: string; reason: string }>(sql`
      SELECT capture_id AS capture, error AS reason FROM assets
      WHERE capture_id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))
        AND state = 'failed' AND error <> ''
      UNION ALL
      SELECT c.id, w.value FROM captures c
      JOIN revisions r ON r.id = c.revision_id,
        json_each(r.payload, '$.warnings') w
      WHERE c.id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))
        AND c.state = 'partial'`))
      reasons.get(row.capture)!.add(row.reason)
  const waits = captureWaits(db, queuedIds(page))
  const missing = missingMedia(db, ids)
  const accounts = memberAccounts(db, [...targets.keys()])
  return page.map((capture): CaptureMember => {
    const collection = targets.get(capture.collectionId)!
    const waiting = waits.get(capture.id)
    const gone = collection.sourceState !== null
    const known = knownGone(capture, collection)
    return {
      jobId: capture.id,
      collectionId: collection.id,
      saved: collection.saved,
      url: collection.url,
      kind: collection.kind,
      ...accountFields(accounts.get(collection.id)),
      state: capture.state,
      ...(waiting ? { waiting } : {}),
      error: capture.error,
      createdAt: capture.createdAt,
      gone,
      ...(known ? { sourceState: known } : {}),
      reasons: [...reasons.get(capture.id)!].toSorted(),
      retryable:
        missing.has(capture.id) || (resubmitted.has(capture.id) && !gone),
    }
  })
}

// --- Retries and pages ------------------------------------------------------

/**
 * Fetch a saved collection again: through the source that saved it, or,
 * when its last capture failed (or `restart`), with the account selected now.
 * Either way it is fetched, never answered from what is stored.
 */
export function recapture(
  ctx: CaptureContext,
  collectionId: string,
  options: {
    restart?: boolean
    key?: string
    options?: CaptureOptions
    updateId?: string
  } = {},
): Job {
  const collection = ctx.db
    .select({ url: collections.url })
    .from(collections)
    .innerJoin(library, eq(library.collectionId, collections.id))
    .where(eq(collections.id, collectionId))
    .get()
  if (!collection) throw new AppError('not_found')
  const last = ctx.db
    .select({ state: captures.state })
    .from(captures)
    .where(eq(captures.collectionId, collectionId))
    .orderBy(desc(captures.createdAt), desc(captures.id))
    .limit(1)
    .get()
  if (!options.restart && last?.state !== 'failed')
    return submit(ctx, {
      refreshId: collectionId,
      key: options.key,
      options: options.options,
      updateId: options.updateId,
    })
  const { platform } = ctx.platforms.resolve(collection.url)
  return submit(ctx, {
    url: collection.url,
    input: collection.url,
    connectionId:
      selectedConnection(ctx.db, platform.description.adapterId) || undefined,
    refetch: true,
    key: options.key,
    options: options.options,
    updateId: options.updateId,
  })
}

/** Capture a record's target again, as a new record. */
export function retryRecord(
  ctx: CaptureContext,
  id: string,
  key?: string,
): Job {
  const row = recordRow(ctx.db, id)
  // The same options, with the date range counted from now.
  const options = publicOptions(storedOptions(row.submission.captureOptions))
  // Deleted from the library since: saving it again is all that is left.
  if (!row.saved) return captureURL(ctx, row.collection.url, key, options, true)
  return recapture(ctx, row.collection.id, { key, options })
}

/**
 * Continue a finished collection record: `more` fetches the next 100 posts,
 * `more1000` the next 1000, both as a new record with the same filters;
 * `continue` reads on where the post cap stopped `until_existing`, in the
 * same record; `page_retry` fetches the last page again. Asking twice for
 * more gives the same job.
 */
export function recordPage(
  ctx: CaptureContext,
  id: string,
  op: string,
  key?: string,
): Job {
  try {
    return recordPageOp(ctx, id, op, key)
  } finally {
    // What this fetches joins the record: it is counted again. Dropped after
    // the work, so a summary written meanwhile does not outlive it.
    dropSummaries(ctx.db, [id])
  }
}

function recordPageOp(
  ctx: CaptureContext,
  id: string,
  op: string,
  key?: string,
): Job {
  const record = toRecord(ctx.db, recordRow(ctx.db, id))
  if (!record.pages) throw new AppError('unsupported')
  const last = collectionProgress(ctx.db, id).pages.at(-1)!
  if (op === 'continue') return continuePages(ctx, last)
  const stored = storedOptions(last.submission.captureOptions)
  if (op === 'page_retry')
    return submit(ctx, {
      url: record.url,
      providerId: last.submission.relatedProvider,
      connectionId: last.submission.relatedConnection ?? undefined,
      pageCursor: last.capture.pageCursor,
      pageSize: last.capture.pageSize,
      collectionLimit: last.submission.collectionLimit,
      options: stored,
      key: `page-retry:${key || newId()}`,
    })
  if (op !== 'more' && op !== 'more1000') throw new AppError('unsupported')
  const limit = op === 'more1000' ? 1000 : 100
  if (limit > 100 && limit > last.capture.maxBatchSize)
    throw new AppError('unsupported')
  const cursor = last.capture.nextPageCursor
  if (!cursor) throw new AppError('no_more_pages')
  const { finalPage: _, ...rest } = stored
  return submit(ctx, {
    url: record.url,
    providerId: last.submission.relatedProvider,
    connectionId: last.submission.relatedConnection ?? undefined,
    pageCursor: cursor,
    pageSize: limit,
    collectionLimit: limit,
    options: { ...rest, posts: 'latest', count: limit },
    key: `more:${id}`,
  })
}

/** Counts for the library page. */
export function librarySize(db: Executor) {
  const one = (query: { get: () => { n: number } | undefined }) =>
    query.get()?.n ?? 0
  return {
    collections: one(
      db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(library),
    ),
    records:
      one(
        db
          .select({ n: sql<number>`count(*)`.mapWith(Number) })
          .from(submissions)
          .where(recordFilterSQL()),
      ) +
      one(
        db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(updates),
      ),
    running: one(
      db
        .select({ n: sql<number>`count(*)`.mapWith(Number) })
        .from(captures)
        .where(captureRunning),
    ),
  }
}
