import { Buffer } from 'node:buffer'
import { and, asc, desc, eq, isNull, like, notLike, or, sql } from 'drizzle-orm'
import { newId } from '#db/id.ts'
import {
  accountSelections,
  assets,
  captureRunning,
  captures,
  collections,
  library,
  revisions,
  submissions,
} from '#db/schema.ts'
import { inJson } from '#db/sql.ts'
import { AppError } from '#errors.ts'
import { submit, type Job } from './submit.ts'
import type { Executor } from '#db/client.ts'
import type { CaptureContext } from './context.ts'
import type { CaptureOptions } from './options.ts'
import type { Payload } from './payload.ts'
import type { StoredTarget } from './related.ts'

const RECORD_PAGE = 30
const MEMBER_PAGE = 50
const MAX_DEPTH = 1000
// Keys of submissions made by the pipeline itself, not by a request.
const INTERNAL_KEYS = ['related:%', 'related-expand:%', 'batch:%', 'retried:%']

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
  options?: CaptureOptions,
): Job {
  const { platform, target } = ctx.platforms.resolve(raw)
  return submit(ctx, {
    url: target.url,
    input: raw,
    connectionId:
      selectedConnection(ctx.db, platform.description.adapterId) || undefined,
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
  done: boolean
  /**
   * Finished members new to the library and ones already saved; absent
   * while any finished member predates recording it.
   */
  added?: number
  updated?: number
}

type Page = { submission: Submission; capture: Capture }

export interface CollectionProgress extends MemberProgress {
  stopped: boolean
  next: string
  maxBatch: number
  error: '' | 'partial_pages'
  /** Failed members a retry would fetch again. */
  retryable: number
  pages: Page[]
}

/** Each record's pages: its submission and the continuation chain, in order. */
function pageChains(db: Executor, roots: string[]): Map<string, Page[]> {
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
      .select({ submission: submissions, capture: captures })
      .from(submissions)
      .innerJoin(captures, eq(captures.id, submissions.captureId))
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

const isPending = (state: string) =>
  state === 'queued' || state === 'downloading'

const isRetryablePage = (page: Page) =>
  page.submission.relatedState === 'complete' &&
  !page.submission.collectionStopped

function memberSubmissions(db: Executor, pageIds: string[]) {
  if (!pageIds.length) return []
  return db
    .select({ submission: submissions, capture: captures })
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
  // Retryable: failed members of finished pages whose source still exists.
  const rows = db.all<{
    root: string
    state: string
    n: number
    retryable: number
    added: number
    updated: number
  }>(sql`
    WITH members AS (
      SELECT p.value ->> '$.root' AS root, c.id AS id, c.state AS state,
        max(p.value ->> '$.retry' AND c.state = 'failed'
          AND a.source_state IS NULL) AS retryable,
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

function progressOf(pages: Page[], counts: MemberCounts): CollectionProgress {
  const urls = new Set<string>()
  for (const page of pages)
    for (const target of page.capture.relatedTargets as StoredTarget[])
      urls.add(target.url)
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
  return {
    total: urls.size,
    ...counts,
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
  return new Map(
    [...chains].map(([root, pages]) => [
      root,
      progressOf(pages, counts.get(root)!),
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
function failureReasons(
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
      SELECT c.error, c.id FROM ids JOIN captures c ON c.id = ids.id
      WHERE c.state = 'failed'
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
    pages
      .filter((p) => p.submission.relatedState === 'failed')
      .map((p) => p.submission.relatedError),
  )
}

// --- Records --------------------------------------------------------------

export interface CaptureRecord {
  id: string
  jobId: string
  collectionId: string
  saved: boolean
  url: string
  input: string
  platform: string
  kind: string
  state: string
  error: string
  createdAt: Date
  finishedAt: Date | null
  media: { total: number; ready: number; failed: number }
  done: boolean
  members?: MemberProgress
  /** A record without members that saved its target: whether it was new. */
  added?: boolean
  stopped?: boolean
  pages?: { more: boolean; more1000: boolean; failed: boolean }
  retryable?: number
}

export function recordFilterSQL() {
  return and(
    isNull(submissions.parentSubmission),
    sql`${submissions.input} <> ''`,
    ...INTERNAL_KEYS.map((key) => notLike(submissions.idemKey, key)),
  )
}

function recordRows(
  db: Executor,
  where: ReturnType<typeof and>,
  limit: number,
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
    .where(and(recordFilterSQL(), where))
    .orderBy(desc(submissions.createdAt), desc(submissions.id))
    .limit(limit)
    .all()
}

/** Members to retry: failed ones on finished pages whose source still exists. */
function retryableMembers(db: Executor, pageIds: string[]) {
  return memberSubmissions(db, pageIds).filter(
    (m) => m.capture.state === 'failed',
  )
}

type RecordRow = ReturnType<typeof recordRows>[number]

/** Records for rows, with a fixed number of queries for any number of rows. */
function toRecords(db: Executor, rows: RecordRow[]): CaptureRecord[] {
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
  return rows.map(({ submission, capture, collection, saved }) => {
    const record: CaptureRecord = {
      id: submission.id,
      jobId: capture.id,
      collectionId: collection.id,
      saved: !!saved,
      url: collection.url,
      input: submission.input,
      platform: collection.platform,
      kind: collection.kind,
      state: capture.state,
      error: capture.error,
      createdAt: submission.createdAt,
      finishedAt: capture.finishedAt,
      media: media.get(capture.id) ?? { total: 0, ready: 0, failed: 0 },
      done: ['complete', 'partial', 'failed'].includes(capture.state),
    }
    const progress = progresses.get(submission.id)
    if (progress) {
      const {
        pages: _,
        stopped,
        next,
        maxBatch,
        error,
        retryable,
        ...members
      } = progress
      record.members = members
      record.stopped = stopped
      record.done = members.done || stopped
      if (record.done && !stopped)
        record.pages = {
          more: !!next,
          more1000: !!next && maxBatch >= 1000,
          failed:
            error === 'partial_pages' ||
            capture.state === 'failed' ||
            capture.state === 'partial',
        }
      if (record.done) record.retryable = retryable
    } else if (
      (capture.state === 'complete' || capture.state === 'partial') &&
      submission.libraryAdded !== null
    )
      record.added = submission.libraryAdded
    return record
  })
}

const toRecord = (db: Executor, row: RecordRow) => toRecords(db, [row])[0]!

export function listRecords(
  db: Executor,
  cursor?: string,
): { items: CaptureRecord[]; next?: string } {
  const after = cursor ? decodeCursor(cursor, 'captures') : undefined
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
    RECORD_PAGE + 1,
  )
  const items = toRecords(db, rows.slice(0, RECORD_PAGE))
  const last = items.at(-1)
  return {
    items,
    ...(rows.length > RECORD_PAGE && last
      ? { next: encodeCursor(last.createdAt, last.id, 'captures') }
      : {}),
  }
}

function recordRow(db: Executor, id: string) {
  const row = recordRows(db, eq(submissions.id, id), 1)[0]
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
  const record = toRecord(db, row)
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
  added: (state, added) => isFinished(state) && added === true,
  updated: (state, added) => isFinished(state) && added === false,
  problem: (state) => state === 'failed' || state === 'partial',
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
  error: string
  createdAt: Date
  gone: boolean
  reasons: string[]
}

export function recordMembers(
  db: Executor,
  id: string,
  state: string,
  cursor?: string,
): { items: CaptureMember[]; next?: string } {
  const wanted = Object.hasOwn(MEMBER_FILTERS, state)
    ? MEMBER_FILTERS[state]
    : undefined
  if (!wanted) throw new AppError('invalid_filter')
  recordRow(db, id)
  const filter = `members:${id}:${state}`
  const after = cursor ? decodeCursor(cursor, filter) : undefined
  const pages = pageChains(db, [id])
    .get(id)!
    .map((p) => p.submission.id)
  // A member listed on several pages is one, new if any listing was new
  // (as `memberCounts` counts it).
  const listed = new Map<string, { capture: Capture; added: boolean | null }>()
  for (const { capture, submission } of memberSubmissions(db, pages)) {
    const seen = listed.get(capture.id)
    const added = submission.libraryAdded
    if (!seen) listed.set(capture.id, { capture, added })
    else if (added !== null && seen.added !== true) seen.added = added
  }
  const members = [...listed.values()]
    .filter((m) => wanted(m.capture.state, m.added))
    .map((m) => m.capture)
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
  const ids = page.map((c) => c.id)
  const targets = new Map(
    (page.length
      ? db
          .select({
            id: collections.id,
            url: collections.url,
            sourceState: collections.sourceState,
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
  const items = page.map((capture): CaptureMember => {
    const collection = targets.get(capture.collectionId)!
    return {
      jobId: capture.id,
      collectionId: collection.id,
      saved: collection.saved,
      url: collection.url,
      state: capture.state,
      error: capture.error,
      createdAt: capture.createdAt,
      gone: collection.sourceState !== null,
      reasons: [...reasons.get(capture.id)!].toSorted(),
    }
  })
  const last = page.at(-1)
  return {
    items,
    ...(members.length > MEMBER_PAGE && last
      ? { next: encodeCursor(last.createdAt, last.id, filter) }
      : {}),
  }
}

// --- Retries and pages ------------------------------------------------------

/**
 * Fetch a saved collection again: through the source that saved it, or,
 * when its last capture failed (or `restart`), with the account selected now.
 */
export function recapture(
  ctx: CaptureContext,
  collectionId: string,
  options: {
    restart?: boolean
    key?: string
    captureOptions?: CaptureOptions
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
      options: options.captureOptions,
    })
  const { platform } = ctx.platforms.resolve(collection.url)
  return submit(ctx, {
    url: collection.url,
    input: collection.url,
    connectionId:
      selectedConnection(ctx.db, platform.description.adapterId) || undefined,
    key: options.key,
    options: options.captureOptions,
  })
}

/** Capture a record's target again, as a new record. */
export function retryRecord(
  ctx: CaptureContext,
  id: string,
  key?: string,
): Job {
  const row = recordRow(ctx.db, id)
  const options =
    (row.submission.captureOptions as CaptureOptions | null) ?? undefined
  // Deleted from the library since: saving it again is all that is left.
  if (!row.saved) return captureURL(ctx, row.collection.url, key, options)
  return recapture(ctx, row.collection.id, { key, captureOptions: options })
}

/**
 * Fetch again the failed members of a finished collection record (or just
 * one of them). Their pages submit them anew; returns how many.
 */
export function retryMembers(
  ctx: CaptureContext,
  id: string,
  memberJobId?: string,
): number {
  const { db } = ctx
  recordRow(db, id)
  return retryFailed(
    ctx,
    collectionProgress(db, id)
      .pages.filter(isRetryablePage)
      .map((p) => p.submission.id),
    memberJobId,
  )
}

export function retryFailed(
  ctx: CaptureContext,
  pageIds: string[],
  memberJobId?: string,
): number {
  return ctx.db.transaction((tx) => {
    const failed = retryableMembers(tx, pageIds).filter(
      (m) => !memberJobId || m.capture.id === memberJobId,
    )
    const goneIds = new Set(
      failed.length
        ? tx
            .select({ id: collections.id })
            .from(collections)
            .where(
              and(
                inJson(
                  collections.id,
                  failed.map((m) => m.capture.collectionId),
                ),
                sql`${collections.sourceState} IS NOT NULL`,
              ),
            )
            .all()
            .map((row) => row.id)
        : [],
    )
    const retry = failed.filter((m) => !goneIds.has(m.capture.collectionId))
    const pages = new Set<string>()
    for (const member of retry) {
      // Frees the original key, so the page submits the target anew.
      tx.update(submissions)
        .set({ idemKey: `retried:${member.submission.id}` })
        .where(eq(submissions.id, member.submission.id))
        .run()
      pages.add(member.submission.parentSubmission!)
    }
    for (const page of pages) {
      tx.update(submissions)
        .set({ relatedState: 'pending' })
        .where(eq(submissions.id, page))
        .run()
      ctx.queue.enqueue(tx, 'related', page)
    }
    return new Set(retry.map((m) => m.capture.id)).size
  })
}

/**
 * Continue a finished collection record: `more` fetches the next page,
 * `more1000` keeps going to about 1000 members, `page_retry` fetches the
 * last page again. The pages form a new record; asking twice for more gives
 * the same job.
 */
export function recordPage(
  ctx: CaptureContext,
  id: string,
  op: string,
  key?: string,
): Job {
  const record = toRecord(ctx.db, recordRow(ctx.db, id))
  if (!record.pages) throw new AppError('unsupported')
  let idem = `more:${id}`
  if (op === 'page_retry') idem = `page-retry:${key || newId()}`
  else if (op !== 'more' && op !== 'more1000') throw new AppError('unsupported')
  const retry = op === 'page_retry'
  const last = collectionProgress(ctx.db, id).pages.at(-1)!
  const options =
    (last.submission.captureOptions as CaptureOptions | null) ?? undefined
  let limit = op === 'more1000' ? 1000 : 0
  if (!retry && limit > last.capture.maxBatchSize)
    throw new AppError('unsupported')
  const cursor = retry ? last.capture.pageCursor : last.capture.nextPageCursor
  if (!cursor && !retry) throw new AppError('no_more_pages')
  let pageSize = limit
  if (retry) {
    limit = last.submission.collectionLimit
    pageSize = last.capture.pageSize
  }
  return submit(ctx, {
    url: record.url,
    providerId: last.submission.relatedProvider,
    connectionId: last.submission.relatedConnection ?? undefined,
    pageCursor: cursor,
    pageSize,
    collectionLimit: limit,
    options,
    key: idem,
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
    records: one(
      db
        .select({ n: sql<number>`count(*)`.mapWith(Number) })
        .from(submissions)
        .where(recordFilterSQL()),
    ),
    running: one(
      db
        .select({ n: sql<number>`count(*)`.mapWith(Number) })
        .from(captures)
        .where(captureRunning),
    ),
  }
}
