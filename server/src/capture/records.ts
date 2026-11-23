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
  collections,
  library,
  revisions,
  submissions,
} from '#db/schema.ts'
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
}

export interface CollectionProgress extends MemberProgress {
  stopped: boolean
  next: string
  maxBatch: number
  error: '' | 'partial_pages'
  reasons: { reason: string; count: number }[]
  pages: { submission: Submission; capture: Capture }[]
}

/** A record's pages: its submission and the continuation chain, in order. */
function pageChain(db: Executor, root: string) {
  const pages: { submission: Submission; capture: Capture }[] = []
  let id: string | null = root
  while (id && pages.length < MAX_DEPTH) {
    const row = db
      .select({ submission: submissions, capture: captures })
      .from(submissions)
      .innerJoin(captures, eq(captures.id, submissions.captureId))
      .where(eq(submissions.id, id))
      .get()
    if (!row) break
    pages.push(row)
    id = row.submission.nextSubmission
  }
  return pages
}

const isPending = (state: string) =>
  state === 'queued' || state === 'downloading'

function memberSubmissions(db: Executor, pageIds: string[]) {
  if (!pageIds.length) return []
  return db
    .select({ submission: submissions, capture: captures })
    .from(submissions)
    .innerJoin(captures, eq(captures.id, submissions.captureId))
    .where(
      and(
        inArray(submissions.parentSubmission, pageIds),
        like(submissions.idemKey, 'related:%'),
      ),
    )
    .all()
}

/** Why captures of a collection fell short, counted per capture. */
function failureReasons(db: Executor, captureList: Capture[], extra: string[]) {
  const reasons = new Map<string, Set<string>>()
  const add = (reason: string, captureId: string) => {
    if (!reason) return
    if (!reasons.has(reason)) reasons.set(reason, new Set())
    reasons.get(reason)!.add(captureId)
  }
  const ids = captureList.map((c) => c.id)
  for (const capture of captureList)
    if (capture.state === 'failed') add(capture.error, capture.id)
  if (ids.length) {
    for (const asset of db
      .select({ captureId: assets.captureId, error: assets.error })
      .from(assets)
      .where(and(inArray(assets.captureId, ids), eq(assets.state, 'failed')))
      .all())
      add(asset.error, asset.captureId)
    const partial = captureList.filter(
      (c) => c.state === 'partial' && c.revisionId,
    )
    if (partial.length)
      for (const revision of db
        .select({ id: revisions.id, payload: revisions.payload })
        .from(revisions)
        .where(
          inArray(
            revisions.id,
            partial.map((c) => c.revisionId!),
          ),
        )
        .all()) {
        const owner = partial.find((c) => c.revisionId === revision.id)!
        for (const warning of (revision.payload as Payload).warnings ?? [])
          add(warning, owner.id)
      }
  }
  for (const [index, reason] of extra.entries()) add(reason, `page:${index}`)
  return [...reasons]
    .map(([reason, set]) => ({ reason, count: set.size }))
    .toSorted((a, b) => b.count - a.count || (a.reason < b.reason ? -1 : 1))
}

export function collectionProgress(
  db: Executor,
  root: string,
): CollectionProgress {
  const pages = pageChain(db, root)
  const members = memberSubmissions(
    db,
    pages.map((p) => p.submission.id),
  )
  const unique = new Map(members.map((m) => [m.capture.id, m.capture]))
  const memberCaptures = [...unique.values()]
  const count = (test: (state: string) => boolean) =>
    memberCaptures.filter((c) => test(c.state)).length
  const urls = new Set<string>()
  for (const page of pages)
    for (const target of page.capture.relatedTargets as StoredTarget[])
      urls.add(target.url)
  const pending = count(isPending)
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
      pending === 0)
  const pageFailed = pages.some(
    (p) =>
      p.capture.state === 'failed' ||
      p.capture.state === 'partial' ||
      p.submission.relatedState === 'failed',
  )
  return {
    total: urls.size,
    complete: count((s) => s === 'complete'),
    partial: count((s) => s === 'partial'),
    failed: count((s) => s === 'failed'),
    pending,
    done,
    stopped: pages.some((p) => p.submission.collectionStopped),
    next: last?.nextPageCursor ?? '',
    maxBatch: last?.maxBatchSize ?? 0,
    error: pageFailed ? 'partial_pages' : '',
    reasons: failureReasons(
      db,
      [...pages.map((p) => p.capture), ...memberCaptures],
      pages
        .filter((p) => p.submission.relatedState === 'failed')
        .map((p) => p.submission.relatedError),
    ),
    pages,
  }
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

function retryablePages(progress: CollectionProgress) {
  return progress.pages.filter(
    (p) =>
      p.submission.relatedState === 'complete' &&
      !p.submission.collectionStopped,
  )
}

function countRetryable(db: Executor, progress: CollectionProgress): number {
  const pages = retryablePages(progress).map((p) => p.submission.id)
  const failed = retryableMembers(db, pages)
  if (!failed.length) return 0
  const gone = new Set(
    db
      .select({ id: collections.id })
      .from(collections)
      .where(
        and(
          inArray(
            collections.id,
            failed.map((m) => m.capture.collectionId),
          ),
          sql`${collections.sourceState} IS NOT NULL`,
        ),
      )
      .all()
      .map((row) => row.id),
  )
  return new Set(
    failed
      .filter((m) => !gone.has(m.capture.collectionId))
      .map((m) => m.capture.id),
  ).size
}

function toRecord(
  db: Executor,
  row: ReturnType<typeof recordRows>[number],
): CaptureRecord {
  const { submission, capture, collection } = row
  const states = db
    .select({ state: assets.state })
    .from(assets)
    .where(eq(assets.captureId, capture.id))
    .all()
  const record: CaptureRecord = {
    id: submission.id,
    jobId: capture.id,
    collectionId: collection.id,
    saved: !!row.saved,
    url: collection.url,
    input: submission.input,
    platform: collection.platform,
    kind: collection.kind,
    state: capture.state,
    error: capture.error,
    createdAt: submission.createdAt,
    finishedAt: capture.finishedAt,
    media: {
      total: states.length,
      ready: states.filter((a) => a.state === 'ready').length,
      failed: states.filter((a) => a.state === 'failed').length,
    },
    done: ['complete', 'partial', 'failed'].includes(capture.state),
  }
  if (capture.isCollection && submission.relatedState !== 'none') {
    const progress = collectionProgress(db, submission.id)
    const {
      pages: _,
      reasons: __,
      stopped,
      next,
      maxBatch,
      error,
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
    if (record.done) record.retryable = countRetryable(db, progress)
  }
  return record
}

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
  const items = rows.slice(0, RECORD_PAGE).map((row) => toRecord(db, row))
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
      ? collectionProgress(db, id).reasons
      : failureReasons(db, [row.capture], []),
  }
}

const MEMBER_STATES: Record<string, string[] | undefined> = {
  '': undefined,
  problem: ['failed', 'partial'],
  pending: ['queued', 'downloading'],
  failed: ['failed'],
  partial: ['partial'],
  complete: ['complete'],
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
  if (!(state in MEMBER_STATES)) throw new AppError('invalid_filter')
  recordRow(db, id)
  const filter = `members:${id}:${state}`
  const after = cursor ? decodeCursor(cursor, filter) : undefined
  const pages = pageChain(db, id).map((p) => p.submission.id)
  const wanted = MEMBER_STATES[state]
  const members = [
    ...new Map(
      memberSubmissions(db, pages).map((m) => [m.capture.id, m.capture]),
    ).values(),
  ]
    .filter((c) => !wanted || wanted.includes(c.state))
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
  const items = page.map((capture): CaptureMember => {
    const collection = db
      .select()
      .from(collections)
      .where(eq(collections.id, capture.collectionId))
      .get()!
    const saved = !!db
      .select({ id: library.collectionId })
      .from(library)
      .where(eq(library.collectionId, collection.id))
      .get()
    const reasons = new Set(
      db
        .select({ error: assets.error })
        .from(assets)
        .where(
          and(eq(assets.captureId, capture.id), eq(assets.state, 'failed')),
        )
        .all()
        .map((a) => a.error)
        .filter(Boolean),
    )
    if (capture.state === 'partial' && capture.revisionId) {
      const revision = db
        .select({ payload: revisions.payload })
        .from(revisions)
        .where(eq(revisions.id, capture.revisionId))
        .get()
      for (const warning of (revision?.payload as Payload | undefined)
        ?.warnings ?? [])
        reasons.add(warning)
    }
    return {
      jobId: capture.id,
      collectionId: collection.id,
      saved,
      url: collection.url,
      state: capture.state,
      error: capture.error,
      createdAt: capture.createdAt,
      gone: collection.sourceState !== null,
      reasons: [...reasons].toSorted(),
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
  const progress = collectionProgress(db, id)
  return retryFailed(
    ctx,
    retryablePages(progress).map((p) => p.submission.id),
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
                inArray(
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
