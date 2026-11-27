import { and, desc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm'
import {
  assets,
  captures,
  collections,
  library,
  relationFetches,
  revisions,
  submissions,
  updates,
  updateSkips,
  type UpdateSkipReason,
  type UpdateTarget,
} from '#db/schema.ts'
import { inJson } from '#db/sql.ts'
import { AppError, isAppError } from '#errors.ts'
import { readJobControl } from '#jobs/control.ts'
import {
  setUpdateJobsPaused,
  SnoozeError,
  withOrigin,
  type Job as QueueJob,
} from '#jobs/queue.ts'
import { memberAccounts } from './accounts.ts'
import { identityRecords } from './identity.ts'
import { budget, storedOptions } from './options.ts'
import { keptCounts, readyProgress, verifyMembers } from './progress.ts'
import { keepRecord, keptRecord } from './record-cache.ts'
import { detailKey, dropSummaries, loadSummaries } from './record-summaries.ts'
import {
  accountFields,
  captureWaits,
  collectionProgress,
  collectionProgresses,
  decodeCursor,
  encodeCursor,
  failureReasons,
  isPending,
  knownCaptures,
  knownStates,
  listingErrors,
  memberPage,
  memberSubmissions,
  pageChains,
  recapture,
  RECORD_PAGE_SIZE,
  recordRow,
  requestRecords,
  type CaptureMember,
  type CaptureRecord,
  type CaptureRecordDetail,
  type CollectionProgress,
  type Listing,
  type MemberProgress,
  type Page,
} from './records.ts'
import { continuePages, stopCollection } from './related.ts'
import {
  failRelations,
  relationProgresses,
  type RelationProgress,
} from './relations.ts'
import {
  failedPages,
  isRetryableList,
  isRetryablePage,
  missingMedia,
  missingMediaSQL,
  pagesMissingMedia,
} from './retry-units.ts'
import { knownGoneSQL, type SourceState } from './source-state.ts'
import { submit, type Job } from './submit.ts'
import { hasOlder, itemKinds, lastPage, savedIds } from './update-start.ts'
import type { Executor } from '#db/client.ts'
import type { CaptureContext } from './context.ts'
import type { Payload } from './payload.ts'

export {
  previewUpdate,
  repeatUpdate,
  savedIds,
  startUpdate,
  type UpdateOptions,
  type UpdatePreview,
  type UpdateTargetInput,
} from './update-start.ts'

/**
 * Items in flight at once: their capture runs or their timeline is still
 * being submitted. The rest wait their turn, so a large folder does not fill
 * the queue at once.
 */
const WINDOW = 5
const FEED_WAIT_MS = 3000
/** How long a finished update still shows on its collection's page. */
const RECENT_MS = 24 * 60 * 60_000
/** Profiles the record details part by part; a folder may hold thousands. */
const MAX_PROFILES = 200

type Update = typeof updates.$inferSelect
type Submission = typeof submissions.$inferSelect
type Capture = typeof captures.$inferSelect

/**
 * Profiles' usernames by id: as their current version says, else as their
 * account's newest version anywhere does (`memberAccounts`).
 */
export function handles(db: Executor, ids: string[]): Map<string, string> {
  const found = new Map<string, string>()
  for (const [id, account] of memberAccounts(db, ids))
    if (account.handle) found.set(id, account.handle)
  return found
}

// --- Running ----------------------------------------------------------------

/** Submit one item of an update; undefined when it cannot be captured. */
function submitItem(
  ctx: CaptureContext,
  update: Update,
  position: number,
): Job | { skipped: UpdateSkipReason } {
  const collectionId = update.collectionIds[position]!
  const item = itemKinds(ctx.db, [collectionId]).get(collectionId)
  if (!item) return { skipped: 'removed' }
  const key = `update:${update.id}:${position}`
  try {
    if (item.kind === 'profile' && update.older) {
      const page = lastPage(ctx.db, collectionId)
      if (!page?.nextPageCursor) return { skipped: 'no_more_pages' }
      return submit(ctx, {
        url: item.url,
        providerId: page.providerId,
        connectionId: page.connectionId ?? undefined,
        pageCursor: page.nextPageCursor,
        ...budget(ctx, update.options),
        options: update.options,
        key,
        updateId: update.id,
      })
    }
    return recapture(ctx, collectionId, {
      key,
      updateId: update.id,
      options: update.options,
    })
  } catch (error) {
    const reason = isAppError(error) ? SKIPS[error.kind] : undefined
    if (reason) return { skipped: reason }
    throw error
  }
}

/** Why an item is skipped, by the error its submission gave. */
const SKIPS: Partial<Record<string, UpdateSkipReason>> = {
  not_found: 'removed',
  unsupported: 'unsupported',
  invalid_target: 'unsupported',
  connection: 'account',
  account_required: 'account',
  no_more_pages: 'no_more_pages',
}

/** How a skipped item reads: why it was not updated. */
export const SKIP_TEXT: Record<UpdateSkipReason, string> = {
  removed: '已移出收藏库',
  unsupported: '平台不支持采集',
  account: '没有可用的采集账号',
  no_more_pages: '没有更早的帖子',
  unknown: '无法更新',
}

/** An update's skipped items, in update order. */
function skipRows(db: Executor, id: string) {
  return db
    .select()
    .from(updateSkips)
    .where(eq(updateSkips.updateId, id))
    .orderBy(updateSkips.position)
    .all()
}

/** Record an item skipped when its turn came, and why. */
function skipItem(
  ctx: CaptureContext,
  tx: Executor,
  update: Update,
  position: number,
  reason: UpdateSkipReason,
): void {
  const collectionId = update.collectionIds[position]!
  const url =
    tx
      .select({ url: collections.url })
      .from(collections)
      .where(eq(collections.id, collectionId))
      .get()?.url ?? ''
  tx.insert(updateSkips)
    .values({
      updateId: update.id,
      position,
      collectionId,
      url,
      reason,
      createdAt: new Date(ctx.now?.() ?? Date.now()),
    })
    .onConflictDoNothing()
    .run()
}

/** Items whose capture runs or whose timeline is still being submitted. */
function inFlight(db: Executor, id: string): number {
  return (
    db.get<{ n: number }>(sql`
      SELECT count(*) AS n FROM submissions s
      JOIN captures c ON c.id = s.capture_id
      WHERE s.update_id = ${id}
        AND (c.state IN ('queued', 'downloading')
          OR (s.related_state = 'pending' AND c.state <> 'failed'))`)?.n ?? 0
  )
}

/**
 * Feed an update's items to the capture queue a few at a time, coming back
 * while the window is full. Each item is recorded as it goes, so a replay
 * never submits one twice.
 */
export function runUpdate(ctx: CaptureContext, job: QueueJob): void {
  const { db } = ctx
  const load = () =>
    db.select().from(updates).where(eq(updates.id, job.ref)).get()
  let update = load()
  if (update?.state !== 'running') return
  let running = inFlight(db, update.id)
  while (update.position < update.collectionIds.length) {
    // Paused meanwhile: the queue keeps the job paused until it resumes.
    if (running >= WINDOW || update.pausedAt)
      throw new SnoozeError(FEED_WAIT_MS)
    const position = update.position
    const submitted = submitItem(ctx, update, position)
    const current = update
    db.transaction((tx) => {
      const moved = tx
        .update(updates)
        .set({
          position: position + 1,
          ...('skipped' in submitted ? { skipped: current.skipped + 1 } : {}),
        })
        .where(and(eq(updates.id, current.id), eq(updates.position, position)))
        .run()
      if ('skipped' in submitted && Number(moved.changes))
        skipItem(ctx, tx, current, position, submitted.skipped)
    })
    if ('state' in submitted && isPending(submitted.state)) running++
    update = load()
    if (update?.state !== 'running') return
  }
  db.update(updates)
    .set({ state: 'complete' })
    .where(and(eq(updates.id, update.id), eq(updates.state, 'running')))
    .run()
}

export function failUpdate(
  ctx: CaptureContext,
  id: string,
  message: string,
): void {
  ctx.db
    .update(updates)
    .set({ state: 'failed', error: message })
    .where(and(eq(updates.id, id), eq(updates.state, 'running')))
    .run()
}

export function loadUpdate(db: Executor, id: string): Update {
  const update = db.select().from(updates).where(eq(updates.id, id)).get()
  if (!update) throw new AppError('not_found')
  return update
}

export function isUpdate(db: Executor, id: string): boolean {
  return !!db
    .select({ id: updates.id })
    .from(updates)
    .where(eq(updates.id, id))
    .get()
}

export function itemRows(db: Executor, ids: string[]) {
  if (!ids.length) return []
  return db
    .select({ submission: submissions, capture: captures })
    .from(submissions)
    .innerJoin(captures, eq(captures.id, submissions.captureId))
    .where(inJson(submissions.updateId, ids))
    .all()
}

const positionOf = (submission: Submission) =>
  Number(submission.idemKey.split(':').at(-1))

/**
 * Stop an update: no further items, pages or members are submitted, and
 * lists not read yet are left. Captures already queued still finish.
 */
export function stopUpdate(ctx: CaptureContext, id: string): void {
  haltUpdate(ctx, id)
  stopParts(ctx, stopPlan(ctx.db, id))
}

/** The first step of stopping an update: it submits nothing further. */
export function haltUpdate(ctx: CaptureContext, id: string): void {
  loadUpdate(ctx.db, id)
  ctx.db.transaction((tx) => {
    tx.update(updates)
      .set({ state: 'stopped', pausedAt: null })
      .where(
        and(
          eq(updates.id, id),
          inArray(updates.state, ['running', 'complete']),
        ),
      )
      .run()
    // What was queued finishes, as when it was not paused.
    setUpdateJobsPaused(tx, id, false)
  })
}

/**
 * What else stopping a halted update stops: its profiles' timelines still
 * read on, and its lists still waiting or read. Read over all its items, so
 * on a read thread in the web process; read after `haltUpdate`, so no item
 * comes after it.
 */
export interface StopPlan {
  timelines: string[]
  lists: string[]
}

export function stopPlan(db: Executor, id: string): StopPlan {
  const items = itemRows(db, [id])
  return {
    timelines: items.flatMap(({ submission, capture }) =>
      capture.isCollection && !submission.collectionStopped
        ? [submission.id]
        : [],
    ),
    lists: db
      .select({ id: relationFetches.id })
      .from(relationFetches)
      .where(
        and(
          inJson(
            relationFetches.submissionId,
            items.map((item) => item.submission.id),
          ),
          inArray(relationFetches.state, ['waiting', 'running']),
        ),
      )
      .all()
      .map((row) => row.id),
  }
}

/**
 * Stop what the plan names, each in its own short write that looks at it
 * again: a timeline stopped or a list settled meanwhile stays as it is.
 */
export function stopParts(ctx: CaptureContext, plan: StopPlan): void {
  for (const submission of plan.timelines) stopCollection(ctx, submission)
  for (const fetch of plan.lists) failRelations(ctx, fetch, '已中止')
}

/**
 * Pause an update: it submits no further items, and its waiting jobs (the
 * captures, pages, downloads it queued) are not taken until it resumes.
 * Jobs already running finish. A finished or stopped update cannot pause.
 */
export function pauseUpdate(
  ctx: CaptureContext,
  id: string,
  /**
   * Its record, counted beforehand (on a read thread): whether it is done
   * takes counting every member.
   */
  record?: Pick<UpdateRecord, 'done'>,
): void {
  const update = loadUpdate(ctx.db, id)
  if (update.pausedAt) return
  if (
    !['running', 'complete'].includes(update.state) ||
    (record ?? updateRecord(ctx.db, id)).done
  )
    throw new AppError('unsupported')
  ctx.db.transaction((tx) => {
    // Stopped since it was read: a stopped update does not pause.
    const now = tx
      .select({ state: updates.state, pausedAt: updates.pausedAt })
      .from(updates)
      .where(eq(updates.id, id))
      .get()
    if (!now || now.pausedAt) return
    if (!['running', 'complete'].includes(now.state))
      throw new AppError('unsupported')
    tx.update(updates)
      .set({ pausedAt: new Date(ctx.now?.() ?? Date.now()) })
      .where(eq(updates.id, id))
      .run()
    setUpdateJobsPaused(tx, id, true)
  })
}

/** Resume a paused update from where it stopped. */
export function resumeUpdate(ctx: CaptureContext, id: string): void {
  loadUpdate(ctx.db, id)
  ctx.db.transaction((tx) => {
    tx.update(updates).set({ pausedAt: null }).where(eq(updates.id, id)).run()
    setUpdateJobsPaused(tx, id, false)
  })
}

/**
 * Capture a failed item of an update again, in its place: its key is freed
 * and the failed request leaves the record. Returns whether it was
 * submitted; one that cannot be stays as it was.
 */
export function retryItem(
  ctx: CaptureContext,
  update: Update,
  item: Submission,
): boolean {
  const keep = { idemKey: item.idemKey, updateId: item.updateId }
  ctx.db
    .update(submissions)
    .set({ idemKey: `retried:${item.id}`, updateId: null })
    .where(eq(submissions.id, item.id))
    .run()
  if ('id' in submitItem(ctx, update, positionOf(item))) return true
  ctx.db.update(submissions).set(keep).where(eq(submissions.id, item.id)).run()
  return false
}

/**
 * Read on where the post cap stopped a profile's timeline, with the same
 * options. The page joins the profile's chain, so its posts are this
 * update's members.
 */
export function continueTimeline(
  ctx: CaptureContext,
  id: string,
  collectionId: string,
  /** `continuePlan`, read beforehand (on a read thread). */
  plan?: ContinuePlan,
): void {
  const { page } = plan ?? continuePlan(ctx.db, id, collectionId)
  // As they are now: stopped since, or the page continued since.
  const last = ctx.db
    .select({ submission: submissions, capture: captures })
    .from(submissions)
    .innerJoin(captures, eq(captures.id, submissions.captureId))
    .where(eq(submissions.id, page))
    .get()
  if (loadUpdate(ctx.db, id).state === 'stopped' || !last)
    throw new AppError('unsupported')
  withOrigin({ updateId: id }, () => continuePages(ctx, last))
  dropSummaries(ctx.db, [id])
}

/** The last page of a profile's timeline in an update, to continue from. */
export interface ContinuePlan {
  page: string
}

/** Read over all the update's items: on a read thread in the web process. */
export function continuePlan(
  db: Executor,
  id: string,
  collectionId: string,
): ContinuePlan {
  const update = loadUpdate(db, id)
  const [g] = gather(db, [update])
  const root = g!.items.find(
    (i) =>
      i.capture.collectionId === collectionId &&
      g!.roots.includes(i.submission.id),
  )
  if (!root) throw new AppError('not_found')
  const last = g!.pages.get(root.submission.id)?.at(-1)
  if (update.state === 'stopped' || !last) throw new AppError('unsupported')
  return { page: last.submission.id }
}

// --- Records ----------------------------------------------------------------

export interface UpdateInfo {
  target: UpdateTarget
  /** The collection or folder updated; '' for a selection. */
  targetId: string
  name: string
  /** A single profile's username. */
  handle: string
  posts: number
  profiles: number
  /** Profiles read on from their last page (抓取更早的帖子). */
  older: boolean
  /** Items not submitted yet. */
  queued: number
  /** Items that could not be captured when their turn came. */
  skipped: number
  /** Started by a watch (定期更新) rather than by hand. */
  watch: boolean
}

export interface ProfilePart {
  collectionId: string
  url: string
  /** Its username and display name, when a stored version has them. */
  handle: string
  name: string
  /** The profile's own capture; `waiting` before its turn, `skipped` if none. */
  state: string
  error: string
  /** Its failed capture only said again what its source is known to be. */
  sourceState?: SourceState
  /** That capture, '' when there is none. */
  jobId: string
  /** Whether a retry would fetch it again, or its missing media. */
  retryable: boolean
  /** Its timeline posts, unless the update left them out. */
  posts?: {
    total: number
    finished: number
    pending: number
    done: boolean
    /** Stopped by the post cap before reaching saved posts; can continue. */
    capped: boolean
    /** Members and later pages a retry would fetch again. */
    retryable: number
    /** What a retry of all of them names. */
    retryId: string
    /** Pages that failed, numbered from 1. */
    pages: { id: string; number: number; error: string }[]
  }
  relations?: RelationProgress[]
}

/** A profile's timeline as its part says it: progress and what failed. */
function postsPart(
  progress: CollectionProgress,
  root: string,
  continuable: boolean,
): NonNullable<ProfilePart['posts']> {
  return {
    total: progress.total,
    finished: progress.complete + progress.partial + progress.failed,
    pending: progress.pending,
    done: progress.done || progress.stopped,
    capped: !!progress.pages.at(-1)?.submission.timelineCapped && continuable,
    retryable: progress.retryable,
    retryId: `posts:${root}`,
    pages: progress.failedPages.map(({ page, index }) => ({
      id: page.submission.id,
      number: index + 1,
      error: page.capture.error || page.submission.relatedError,
    })),
  }
}

/** Lists of a request, with whether a retry would fetch each again. */
function retryableLists(
  lists: RelationProgress[],
  item: { submission: Submission; capture: Capture },
): RelationProgress[] {
  return lists.map((list) => ({
    ...list,
    retryable: isRetryableList(list.state, {
      captureState: item.capture.state,
      stopped: item.submission.collectionStopped,
    }),
  }))
}

export interface UpdateRecord extends CaptureRecord {
  update: UpdateInfo
}

export interface UpdateRecordDetail extends CaptureRecordDetail {
  update: UpdateInfo
  profiles: ProfilePart[]
  /** Profiles beyond those detailed. */
  moreProfiles: number
}

interface Gathered {
  update: Update
  items: { submission: Submission; capture: Capture }[]
  roots: string[]
  pages: Map<string, Page[]>
  relations: Map<string, RelationProgress[]>
}

/** Items, timeline pages and lists of several updates at once. */
function gather(db: Executor, rows: Update[]): Gathered[] {
  const items = itemRows(
    db,
    rows.map((row) => row.id),
  )
  const roots = items
    .filter(
      (i) => i.capture.isCollection && i.submission.relatedState !== 'none',
    )
    .map((i) => i.submission.id)
  const pages = pageChains(db, roots)
  const relations = relationProgresses(
    db,
    items.map((i) => i.submission.id),
  )
  return rows.map((update) => {
    const own = items
      .filter((i) => i.submission.updateId === update.id)
      .toSorted((a, b) => positionOf(a.submission) - positionOf(b.submission))
    const ownRoots = new Set(own.map((i) => i.submission.id))
    return {
      update,
      items: own,
      roots: roots.filter((root) => ownRoots.has(root)),
      pages: new Map([...pages].filter(([root]) => ownRoots.has(root))),
      relations: new Map(
        [...relations].filter(([submission]) => ownRoots.has(submission)),
      ),
    }
  })
}

const allPages = (g: Gathered) => [...g.pages.values()].flat()

/**
 * Captures of an update by state, with new and updated among the finished,
 * from what the worker keeps (`progress.ts`) where it keeps it, counted over
 * all of the members otherwise.
 */
function memberCounts(db: Executor, g: Gathered) {
  const pages = allPages(g).map((page) => ({
    id: page.submission.id,
    retry: isRetryablePage(page) ? 1 : 0,
  }))
  return (
    (readyProgress(db, g.update.id)
      ? keptCounts(db, g.update.id, pages)
      : undefined) ?? countMembersFull(db, g)
  )
}

/**
 * Compare the kept progress of an update with a count over all of its
 * members; what differs, as text (nothing when exact).
 */
export function verifyProgress(db: Executor, id: string): string[] {
  const [g] = gather(db, [loadUpdate(db, id)])
  const problems = verifyMembers(db, id)
  const pages = allPages(g!).map((page) => ({
    id: page.submission.id,
    retry: isRetryablePage(page) ? 1 : 0,
  }))
  const kept = keptCounts(db, id, pages)
  if (!kept) return problems
  const full = countMembersFull(db, g!)
  for (const key of Object.keys(full) as (keyof typeof full)[])
    if (kept[key] !== full[key])
      problems.push(`${key}: kept ${kept[key]}, counted ${full[key]}`)
  return problems
}

/** The same counted over all of the members: what the kept ones must equal. */
function countMembersFull(db: Executor, g: Gathered) {
  const pages = allPages(g).map((page) => ({
    id: page.submission.id,
    retry: isRetryablePage(page) ? 1 : 0,
  }))
  const rows = db.all<{
    state: string
    n: number
    retryable: number
    added: number
    updated: number
    finished: number | null
  }>(sql`
    WITH src(capture_id, added, retry) AS (
      -- An item is captured again while it is still saved.
      SELECT s.capture_id, s.library_added, EXISTS (
          SELECT 1 FROM captures i JOIN library l ON l.collection_id = i.collection_id
          WHERE i.id = s.capture_id)
      FROM submissions s
      WHERE s.update_id = ${g.update.id}
      UNION ALL
      SELECT s.capture_id, s.library_added, p.value ->> '$.retry'
      FROM json_each(${JSON.stringify(pages)}) p
      JOIN submissions s ON s.parent_submission = p.value ->> '$.id'
      WHERE s.idem_key LIKE 'related:%'
    ),
    captured AS (
      SELECT c.id AS id, c.collection_id AS collection,
        CASE WHEN ${sql.raw(knownGoneSQL('c', 'a'))} THEN 'known'
          ELSE c.state END AS state,
        c.created_at AS created, c.finished_at AS finished,
        max(src.added) AS added,
        max((src.retry AND c.state = 'failed' AND a.source_state IS NULL)
          OR ${missingMediaSQL}) AS retryable
      FROM src
      JOIN captures c ON c.id = src.capture_id
      JOIN collections a ON a.id = c.collection_id
      GROUP BY c.id
    ),
    -- A collection both updated and on a profile's page is one member: its
    -- newest capture, new if any of its listings was.
    ranked AS (
      SELECT *,
        row_number() OVER (PARTITION BY collection ORDER BY created DESC, id DESC)
          AS n,
        max(added) OVER (PARTITION BY collection) AS any_added
      FROM captured
    ),
    members AS (
      SELECT id, state, finished, any_added AS added, retryable
      FROM ranked WHERE n = 1
    )
    SELECT state, count(*) AS n, sum(retryable) AS retryable,
      count(*) FILTER (WHERE added = 1) AS added,
      count(*) FILTER (WHERE added = 0) AS updated,
      max(finished) AS finished
    FROM members
    GROUP BY state`)
  const counts = {
    total: 0,
    complete: 0,
    partial: 0,
    failed: 0,
    pending: 0,
    known: 0,
    retryable: 0,
    added: 0,
    updated: 0,
    unknown: 0,
    finishedAt: 0,
  }
  for (const row of rows) {
    counts.total += row.n
    counts.retryable += row.retryable
    counts.finishedAt = Math.max(counts.finishedAt, row.finished ?? 0)
    if (
      row.state === 'complete' ||
      row.state === 'partial' ||
      row.state === 'known'
    ) {
      counts[row.state] += row.n
      counts.added += row.added
      counts.updated += row.updated
      counts.unknown += row.n - row.added - row.updated
    } else if (row.state === 'failed') counts.failed += row.n
    else if (isPending(row.state)) counts.pending += row.n
  }
  return counts
}

/** An update's list fetches, with whether a retry would fetch each again. */
function listsOf(g: Gathered): RelationProgress[] {
  const items = new Map(g.items.map((i) => [i.submission.id, i]))
  return [...g.relations].flatMap(([submission, lists]) =>
    retryableLists(lists, items.get(submission)!),
  )
}

/** Failed pages and later pages missing media, over an update's timelines. */
function pageRetries(db: Executor, g: Gathered): number {
  let count = 0
  for (const pages of g.pages.values()) count += failedPages(pages).length
  for (const ids of pagesMissingMedia(db, g.pages).values()) count += ids.length
  return count
}

const listPending = (r: RelationProgress) =>
  r.state === 'waiting' || r.state === 'running'

function toUpdateRecord(db: Executor, g: Gathered): UpdateRecord {
  const { update } = g
  const kinds = itemKinds(db, update.collectionIds)
  let posts = 0
  let profiles = 0
  for (const id of update.collectionIds) {
    const kind = kinds.get(id)?.kind
    if (kind === 'profile') profiles++
    else if (kind) posts++
  }
  const counts = memberCounts(db, g)
  const lists = listsOf(g)
  const listsPending = lists.filter(listPending).length
  const listsFailed = lists.filter((r) => r.state === 'failed').length
  const queued =
    update.state === 'running'
      ? update.collectionIds.length - update.position
      : 0
  const pagePending = allPages(g).some(
    (p) =>
      isPending(p.capture.state) ||
      (p.submission.relatedState === 'pending' && p.capture.state !== 'failed'),
  )
  const stopped = update.state === 'stopped'
  const done =
    stopped ||
    (update.state !== 'running' &&
      counts.pending === 0 &&
      !pagePending &&
      listsPending === 0)
  const members: MemberProgress = {
    total: counts.total + lists.length + queued,
    complete: counts.complete,
    partial: counts.partial,
    failed: counts.failed + listsFailed,
    pending: counts.pending + listsPending,
    known: counts.known,
    done,
    ...(counts.unknown ? {} : { added: counts.added, updated: counts.updated }),
  }
  // An item that only said again what it is known to be did not fail.
  const known = knownCaptures(
    db,
    g.items.flatMap((i) =>
      i.capture.state === 'failed' ? [i.capture.id] : [],
    ),
  )
  const failedItems = g.items.filter(
    (i) => i.capture.state === 'failed' && !known.has(i.capture.id),
  ).length
  let state = 'queued'
  if (done)
    if (
      update.state === 'failed' ||
      (g.items.length && failedItems === g.items.length)
    )
      state = 'failed'
    else if (members.failed + members.partial > 0 || update.skipped)
      state = 'partial'
    else state = 'complete'
  const target =
    update.target === 'collection'
      ? db
          .select({ collection: collections, saved: library.collectionId })
          .from(collections)
          .leftJoin(library, eq(library.collectionId, collections.id))
          .where(eq(collections.id, update.targetId))
          .get()
      : undefined
  const media = g.items.length
    ? db
        .select({
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
            g.items.map((i) => i.capture.id),
          ),
        )
        .get()
    : undefined
  const only = update.target === 'collection' ? g.items[0]?.capture : undefined
  const waiting =
    only?.state === 'queued'
      ? captureWaits(db, [only.id]).get(only.id)
      : undefined
  return {
    id: update.id,
    jobId: only?.id ?? '',
    collectionId: target?.collection.id ?? '',
    saved: !!target?.saved,
    url: target?.collection.url ?? '',
    input: '',
    platform: target?.collection.platform ?? '',
    kind: target?.collection.kind ?? '',
    state,
    ...(waiting ? { waiting } : {}),
    error: update.error,
    createdAt: update.createdAt,
    finishedAt: done && counts.finishedAt ? new Date(counts.finishedAt) : null,
    media: media ?? { total: 0, ready: 0, failed: 0 },
    done,
    members,
    stopped,
    ...(update.pausedAt && !done ? { paused: true } : {}),
    ...(!done && readJobControl(db).paused ? { pausedAll: true } : {}),
    retryable:
      counts.retryable +
      pageRetries(db, g) +
      lists.filter((r) => r.retryable).length,
    mediaRetryable: !!only && missingMedia(db, [only.id]).has(only.id),
    options: update.options,
    update: {
      target: update.target,
      targetId: update.targetId,
      name: update.name,
      handle:
        update.target === 'collection'
          ? (handles(db, [update.targetId]).get(update.targetId) ?? '')
          : '',
      posts,
      profiles,
      older: update.older,
      queued,
      skipped: update.skipped,
      watch: update.origin === 'watch',
    },
  }
}

/**
 * What a kept record must still match: of an update's own row, and whether
 * its target is saved. While in progress (`running`) not its position,
 * which moves with every item: its numbers may lag by `RUNNING_TTL`.
 */
export const updateStamp = (
  row: Pick<Update, 'state' | 'position' | 'skipped' | 'error' | 'pausedAt'>,
  saved: boolean,
  running = false,
) =>
  JSON.stringify([
    row.state,
    ...(running ? [] : [row.position]),
    row.skipped,
    row.error,
    row.pausedAt?.getTime(),
    saved,
  ])

/** Updates' records counted now, whatever is kept (and not kept). */
export function countUpdates(db: Executor, rows: Update[]): UpdateRecord[] {
  return gather(db, rows).map((g) => toUpdateRecord(db, g))
}

/** Whether each update's target is saved, by update id. */
export function savedTargets(
  db: Executor,
  rows: Pick<Update, 'id' | 'target' | 'targetId'>[],
): Set<string> {
  const saved = savedIds(
    db,
    rows.flatMap((row) => (row.target === 'collection' ? [row.targetId] : [])),
  )
  return new Set(
    rows.flatMap((row) =>
      row.target === 'collection' && saved.has(row.targetId) ? [row.id] : [],
    ),
  )
}

/** The records of these updates already counted: written down, or kept. */
function countedUpdates(
  db: Executor,
  rows: Update[],
  saved: Set<string>,
): Map<string, UpdateRecord> {
  const summaries = loadSummaries<UpdateRecord>(
    db,
    rows.map((row) => row.id),
  )
  const found = new Map<string, UpdateRecord>()
  for (const row of rows) {
    const stamp = updateStamp(row, saved.has(row.id))
    const written = summaries.get(row.id)
    if (written?.stamp === stamp) {
      found.set(row.id, written.record)
      continue
    }
    const kept = keptRecord<UpdateRecord>(
      row.id,
      stamp,
      updateStamp(row, saved.has(row.id), true),
    )
    if (kept) found.set(row.id, kept)
  }
  return found
}

/** Keep an update's record just counted: for a minute, or while in progress. */
function keepUpdate(row: Update, saved: boolean, record: UpdateRecord) {
  keepRecord(
    row.id,
    updateStamp(row, saved, !record.done),
    record,
    !record.done,
  )
}

export function updateRecords(db: Executor, rows: Update[]): UpdateRecord[] {
  const saved = savedTargets(db, rows)
  const found = countedUpdates(db, rows, saved)
  const counted = new Map(
    countUpdates(
      db,
      rows.filter((row) => !found.has(row.id)),
    ).map((record) => [record.id, record]),
  )
  return rows.map((row) => {
    const record = found.get(row.id) ?? counted.get(row.id)!
    if (!found.has(row.id)) keepUpdate(row, saved.has(row.id), record)
    return record
  })
}

export function updateRecord(db: Executor, id: string): UpdateRecord {
  return updateRecords(db, [loadUpdate(db, id)])[0]!
}

/** Each profile of an update with how its parts went, in update order. */
function profileParts(db: Executor, g: Gathered): ProfilePart[] {
  const { update } = g
  const kinds = itemKinds(db, update.collectionIds)
  const byPosition = new Map(g.items.map((i) => [positionOf(i.submission), i]))
  const positions = update.collectionIds
    .map((id, position) => ({ id, position }))
    .filter(({ id }) => kinds.get(id)?.kind === 'profile')
    .slice(0, MAX_PROFILES)
  const names = memberAccounts(
    db,
    positions.map(({ id }) => id),
  )
  const progresses = collectionProgresses(
    db,
    positions.flatMap(({ position }) => {
      const item = byPosition.get(position)
      return item && g.roots.includes(item.submission.id)
        ? [item.submission.id]
        : []
    }),
  )
  const captureIds = positions.flatMap(({ position }) => {
    const item = byPosition.get(position)
    return item ? [item.capture.id] : []
  })
  const missing = missingMedia(db, captureIds)
  const skips = new Map(
    skipRows(db, update.id).map((skip) => [skip.position, skip]),
  )
  const failed = g.items.filter((i) => i.capture.state === 'failed')
  const saved = savedIds(
    db,
    failed.map((i) => i.capture.collectionId),
  )
  const gone = goneIds(
    db,
    failed.map((i) => i.capture.collectionId),
  )
  const known = knownStates(
    db,
    failed.map((i) => i.capture.id),
  )
  return positions.map(({ id, position }) => {
    const item = byPosition.get(position)
    const url = kinds.get(id)!.url
    const skip = skips.get(position)
    const { handle = '', name = '' } = names.get(id) ?? {}
    if (!item)
      return {
        collectionId: id,
        url,
        handle,
        name,
        state: position < update.position ? 'skipped' : 'waiting',
        error: skip ? SKIP_TEXT[skip.reason] : '',
        jobId: '',
        retryable: false,
      }
    const progress = progresses.get(item.submission.id)
    const relations = g.relations.get(item.submission.id)
    const collection = item.capture.collectionId
    const sourceState = known.get(item.capture.id)
    return {
      collectionId: collection,
      url,
      handle,
      name,
      state: item.capture.state,
      // Saying again what the source is known to be is no failure.
      error: sourceState ? '' : item.capture.error,
      ...(sourceState ? { sourceState } : {}),
      jobId: item.capture.id,
      retryable:
        missing.has(item.capture.id) ||
        (item.capture.state === 'failed' &&
          saved.has(collection) &&
          !gone.has(collection)),
      ...(update.options.posts !== 'none' && progress
        ? {
            posts: postsPart(
              progress,
              item.submission.id,
              update.state !== 'stopped',
            ),
          }
        : {}),
      ...(relations ? { relations: retryableLists(relations, item) } : {}),
    }
  })
}

/** Collections among these the source reported gone. */
export function goneIds(db: Executor, ids: string[]): Set<string> {
  if (!ids.length) return new Set()
  return new Set(
    db
      .select({ id: collections.id })
      .from(collections)
      .where(
        and(inJson(collections.id, ids), isNotNull(collections.sourceState)),
      )
      .all()
      .map((row) => row.id),
  )
}

/**
 * A profile record's own part, as an update's profiles show theirs: its
 * profile, timeline and lists. Its own failed capture is not retried here
 * but by capturing it again as a new record.
 */
export function recordProfiles(
  db: Executor,
  record: CaptureRecord,
): ProfilePart[] {
  // A request still being identified has no profile yet.
  if (record.kind !== 'profile' || !record.collectionId) return []
  const row = recordRow(db, record.id)
  if (!row.capture.isCollection) return []
  const progress =
    row.submission.relatedState === 'none'
      ? undefined
      : collectionProgress(db, record.id)
  const options = storedOptions(row.submission.captureOptions)
  const { handle = '', name = '' } =
    memberAccounts(db, [row.collection.id]).get(row.collection.id) ?? {}
  const sourceState = knownStates(db, [row.capture.id]).get(row.capture.id)
  return [
    {
      collectionId: row.collection.id,
      url: row.collection.url,
      handle,
      name,
      state: row.capture.state,
      error: sourceState ? '' : row.capture.error,
      ...(sourceState ? { sourceState } : {}),
      jobId: row.capture.id,
      retryable: record.mediaRetryable,
      ...(options.posts !== 'none' && progress
        ? // The record reads on itself (its 继续抓取), not its part.
          { posts: postsPart(progress, record.id, false) }
        : {}),
      ...(record.relations ? { relations: record.relations } : {}),
    },
  ]
}

export function updateDetail(db: Executor, id: string): UpdateRecordDetail {
  const row = loadUpdate(db, id)
  const saved = savedTargets(db, [row])
  // A finished update's detail is written down with its record.
  const written = loadSummaries<UpdateRecordDetail>(db, [detailKey(id)]).get(
    detailKey(id),
  )
  if (written?.stamp === updateStamp(row, saved.has(id))) return written.record
  return countUpdateDetail(db, row, saved.has(id))
}

/** An update's detail counted now; `known` is its record, if counted. */
export function countUpdateDetail(
  db: Executor,
  row: Update,
  saved: boolean,
  known?: UpdateRecord,
): UpdateRecordDetail {
  const id = row.id
  const [g] = gather(db, [row])
  let record =
    known ?? countedUpdates(db, [row], new Set(saved ? [id] : [])).get(id)
  if (!record) {
    record = toUpdateRecord(db, g!)
    keepUpdate(row, saved, record)
  }
  const pages = allPages(g!)
  // A single post's record shows its media, like a capture's.
  const lone =
    g!.update.target === 'collection' && !g!.items[0]?.capture.isCollection
      ? g!.items[0]?.capture
      : undefined
  const revision = lone?.revisionId
    ? db
        .select({ payload: revisions.payload })
        .from(revisions)
        .where(eq(revisions.id, lone.revisionId))
        .get()
    : undefined
  const profileCount = record.update.profiles
  const profiles = profileParts(db, g!)
  return {
    ...record,
    warnings: (revision?.payload as Payload | undefined)?.warnings ?? [],
    mediaItems: lone
      ? db
          .select({
            position: assets.position,
            kind: assets.kind,
            purpose: assets.purpose,
            state: assets.state,
            error: assets.error,
          })
          .from(assets)
          .where(eq(assets.captureId, lone.id))
          .orderBy(assets.position)
          .limit(500)
          .all()
      : [],
    reasons: failureReasons(
      db,
      g!.items.map((i) => i.capture.id),
      pages.map((p) => p.submission.id),
      listingErrors(db, pages),
    ),
    profiles,
    moreProfiles: profileCount - profiles.length,
  }
}

/**
 * One listing per collection, of its newest capture, new if any listing of
 * the collection was (as `memberCounts` counts them).
 */
function newestPerCollection(listings: Listing[]) {
  const newest = new Map<string, Listing>()
  const added = new Map<string, boolean | null>()
  for (const listing of listings) {
    const key = listing.capture.collectionId
    const seen = newest.get(key)
    const later =
      !seen ||
      listing.capture.createdAt.getTime() > seen.capture.createdAt.getTime() ||
      (listing.capture.createdAt.getTime() ===
        seen.capture.createdAt.getTime() &&
        listing.capture.id > seen.capture.id)
    if (later) newest.set(key, listing)
    const value = listing.submission.libraryAdded
    const before = added.get(key) ?? null
    added.set(
      key,
      before === true || value === null ? (before ?? value) : value,
    )
  }
  return [...newest].map(([key, listing]) => ({
    capture: listing.capture,
    submission: { ...listing.submission, libraryAdded: added.get(key) ?? null },
  }))
}

/** An update's members: its captures, their timelines' posts and lists. */
export function updateMembers(
  db: Executor,
  id: string,
  state: string,
  cursor?: string,
): { items: CaptureMember[]; next?: string } {
  const [g] = gather(db, [loadUpdate(db, id)])
  const pages = allPages(g!).map((p) => p.submission.id)
  const resubmit = new Set(
    allPages(g!)
      .filter(isRetryablePage)
      .map((p) => p.submission.id),
  )
  const saved = savedIds(
    db,
    g!.items.map((i) => i.capture.collectionId),
  )
  const urls = new Map(
    (g!.items.length
      ? db
          .select({ id: collections.id, url: collections.url })
          .from(collections)
          .where(
            inJson(
              collections.id,
              g!.items.map((i) => i.capture.collectionId),
            ),
          )
          .all()
      : []
    ).map((row) => [row.id, row.url]),
  )
  const fetches = g!.items.length
    ? db
        .select({ fetch: relationFetches, submission: submissions })
        .from(relationFetches)
        .innerJoin(
          submissions,
          eq(submissions.id, relationFetches.submissionId),
        )
        .where(
          inJson(
            relationFetches.submissionId,
            g!.items.map((i) => i.submission.id),
          ),
        )
        .all()
    : []
  const captureOf = new Map(g!.items.map((i) => [i.submission.id, i.capture]))
  const skipped = skipRows(db, id)
  const names = memberAccounts(db, [
    ...g!.items.map((i) => i.capture.collectionId),
    ...skipped.map((s) => s.collectionId),
  ])
  const lists = fetches.map(({ fetch, submission }): CaptureMember => {
    const capture = captureOf.get(fetch.submissionId!)!
    let listState = 'complete'
    if (fetch.state === 'waiting' || fetch.state === 'running')
      listState = 'queued'
    else if (fetch.state === 'failed') listState = 'failed'
    return {
      jobId: fetch.id,
      collectionId: capture.collectionId,
      saved: true,
      url: urls.get(capture.collectionId) ?? '',
      state: listState,
      error: fetch.error,
      createdAt: fetch.createdAt,
      gone: false,
      reasons: [],
      retryable: isRetryableList(fetch.state, {
        captureState: capture.state,
        stopped: submission.collectionStopped,
      }),
      list: fetch.list,
      ...accountFields(names.get(capture.collectionId)),
    }
  })
  // Items skipped when their turn came, each with why; one still saved
  // links to its page.
  const stillSaved = savedIds(
    db,
    skipped.map((s) => s.collectionId),
  )
  const skips = skipped.map((skip): CaptureMember => ({
    jobId: `skipped:${skip.position}`,
    collectionId: skip.collectionId,
    saved: stillSaved.has(skip.collectionId),
    url: skip.url,
    ...accountFields(names.get(skip.collectionId)),
    state: 'skipped',
    error: SKIP_TEXT[skip.reason],
    createdAt: skip.createdAt,
    gone: false,
    reasons: [],
    retryable: false,
  }))
  return memberPage(
    db,
    `update:${id}`,
    state,
    cursor,
    newestPerCollection([...g!.items, ...memberSubmissions(db, pages)]),
    [...lists, ...skips],
    ({ capture, submission }) =>
      submission.updateId === id
        ? saved.has(capture.collectionId)
        : resubmit.has(submission.parentSubmission ?? ''),
  )
}

/**
 * The newest update of a collection, while it runs or for a day after it
 * started, and whether its profile has older posts to read.
 */
export function collectionUpdate(
  ctx: Pick<CaptureContext, 'db' | 'now'>,
  collectionId: string,
): { record?: { id: string; done: boolean }; older: boolean } {
  const { db } = ctx
  const saved = itemKinds(db, [collectionId]).get(collectionId)
  if (!saved) throw new AppError('not_found')
  const own = db
    .select()
    .from(updates)
    .where(
      and(eq(updates.target, 'collection'), eq(updates.targetId, collectionId)),
    )
    .orderBy(desc(updates.createdAt), desc(updates.id))
    .limit(1)
    .get()
  const viaItem = db
    .select({ update: updates })
    .from(captures)
    .innerJoin(submissions, eq(submissions.captureId, captures.id))
    .innerJoin(updates, eq(updates.id, submissions.updateId))
    .where(eq(captures.collectionId, collectionId))
    .orderBy(desc(updates.createdAt), desc(updates.id))
    .limit(1)
    .get()?.update
  const newest = [own, viaItem]
    .filter((u): u is Update => !!u)
    .toSorted((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
  const older = saved.kind === 'profile' && hasOlder(db, collectionId)
  if (!newest) return { older }
  const record = updateRecord(db, newest.id)
  const now = ctx.now?.() ?? Date.now()
  if (record.done && newest.createdAt.getTime() < now - RECENT_MS)
    return { older }
  return { record: { id: record.id, done: record.done }, older }
}

/** Requests and updates together, newest first. */
export function listRecords(
  db: Executor,
  cursor?: string,
): { items: (CaptureRecord | UpdateRecord)[]; next?: string } {
  const after = cursor ? decodeCursor(cursor, 'captures') : undefined
  const limit = RECORD_PAGE_SIZE + 1
  const requests = [
    ...requestRecords(db, after, limit),
    ...identityRecords(db, after, limit),
  ]
  const rows = db
    .select()
    .from(updates)
    .where(
      after
        ? or(
            sql`${updates.createdAt} < ${after.at.getTime()}`,
            and(
              sql`${updates.createdAt} = ${after.at.getTime()}`,
              sql`${updates.id} < ${after.id}`,
            ),
          )
        : undefined,
    )
    .orderBy(desc(updates.createdAt), desc(updates.id))
    .limit(limit)
    .all()
  const order = (a: { createdAt: Date; id: string }, b: typeof a) =>
    b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1)
  const merged = [
    ...requests.map((record) => ({
      id: record.id,
      createdAt: record.createdAt,
      row: undefined,
    })),
    ...rows.map((row) => ({ id: row.id, createdAt: row.createdAt, row })),
  ].toSorted(order)
  const shown = merged.slice(0, RECORD_PAGE_SIZE)
  const views = new Map(
    updateRecords(
      db,
      shown.flatMap((entry) => (entry.row ? [entry.row] : [])),
    ).map((record) => [record.id, record]),
  )
  const requestById = new Map(requests.map((record) => [record.id, record]))
  const items = shown.map(
    (entry) => views.get(entry.id) ?? requestById.get(entry.id)!,
  )
  const last = items.at(-1)
  return {
    items,
    ...(merged.length > RECORD_PAGE_SIZE && last
      ? { next: encodeCursor(last.createdAt, last.id, 'captures') }
      : {}),
  }
}
