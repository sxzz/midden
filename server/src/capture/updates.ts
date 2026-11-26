import { and, desc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm'
import { newId } from '#db/id.ts'
import {
  assets,
  captureMetrics,
  captures,
  collections,
  entities,
  entityVersions,
  folders,
  library,
  relationFetches,
  revisionEntities,
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
import { parseFilterQuery } from '#library/filter-query.ts'
import { updateSelection } from '#library/list.ts'
import {
  budget,
  checkOptions,
  DEFAULT_OPTIONS,
  storedOptions,
  type CaptureOptions,
} from './options.ts'
import { keepRecord, keptRecord } from './record-cache.ts'
import {
  captureWaits,
  collectionProgress,
  collectionProgresses,
  decodeCursor,
  encodeCursor,
  failureReasons,
  isPending,
  knownCaptures,
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
import { knownGoneSQL } from './source-state.ts'
import { submit, type Job } from './submit.ts'
import type { Executor } from '#db/client.ts'
import type { CaptureContext } from './context.ts'
import type { Payload } from './payload.ts'

/** A library selection updates at most this many collections. */
const MAX_SELECTION = 500
/** A folder updates at most this many. */
const MAX_FOLDER = 10_000
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
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

type Update = typeof updates.$inferSelect
type Submission = typeof submissions.$inferSelect
type Capture = typeof captures.$inferSelect

export type UpdateTargetInput =
  | { target: 'collection'; id: string }
  | { target: 'folder'; id: string }
  | { target: 'many'; ids: string[] }

export interface UpdateOptions {
  /** What each item captures; the defaults when absent. */
  options?: CaptureOptions
  /** Profiles read on from the page after their last one. */
  older?: boolean
  /** Idempotency key: a repeat returns the update it started. */
  key?: string
  /** The watch (定期更新) starting it; its work ranks below manual work. */
  watchId?: string
}

// --- Targets ----------------------------------------------------------------

interface Resolved {
  target: UpdateTarget
  targetId: string
  name: string
  collectionIds: string[]
}

export function savedIds(db: Executor, ids: string[]): Set<string> {
  return new Set(
    ids.length
      ? db
          .select({ id: library.collectionId })
          .from(library)
          .where(inJson(library.collectionId, ids))
          .all()
          .map((row) => row.id)
      : [],
  )
}

/** What a target holds now, each collection once. */
function resolveTarget(db: Executor, input: UpdateTargetInput): Resolved {
  if (input.target === 'collection') {
    if (!UUID.test(input.id) || !savedIds(db, [input.id]).size)
      throw new AppError('not_found')
    return {
      target: 'collection',
      targetId: input.id,
      name: '',
      collectionIds: [input.id],
    }
  }
  if (input.target === 'folder') {
    const folder = UUID.test(input.id)
      ? db.select().from(folders).where(eq(folders.id, input.id)).get()
      : undefined
    if (!folder) throw new AppError('not_found')
    // Posts there only through an account the update covers come with it.
    const ids = updateSelection(
      db,
      parseFilterQuery(folder.filter).filter,
      MAX_FOLDER + 1,
    )
    if (ids.length > MAX_FOLDER)
      throw new AppError(
        'invalid_request',
        `收藏夹内容过多，一次最多更新 ${MAX_FOLDER} 项`,
      )
    if (!ids.length) throw new AppError('invalid_request', '收藏夹是空的')
    return {
      target: 'folder',
      targetId: folder.id,
      name: folder.name,
      collectionIds: ids,
    }
  }
  if (input.ids.some((id) => !UUID.test(id))) throw new AppError('unsupported')
  const unique = [...new Set(input.ids)]
  if (unique.length === 0 || unique.length > MAX_SELECTION)
    throw new AppError('unsupported')
  if (savedIds(db, unique).size !== unique.length)
    throw new AppError('not_found')
  return { target: 'many', targetId: '', name: '', collectionIds: unique }
}

/** Collection kinds (`post`, `profile`) and adapters, by id. */
function itemKinds(db: Executor, ids: string[]) {
  return new Map(
    (ids.length
      ? db
          .select({
            id: collections.id,
            kind: collections.kind,
            url: collections.url,
            adapterId: library.adapterId,
          })
          .from(collections)
          .innerJoin(library, eq(library.collectionId, collections.id))
          .where(inJson(collections.id, ids))
          .all()
      : []
    ).map((row) => [row.id, row]),
  )
}

/** Saved profiles' usernames as their current version says, by id. */
export function handles(db: Executor, ids: string[]): Map<string, string> {
  if (!ids.length) return new Map()
  const rows = db
    .select({ id: collections.id, data: entityVersions.data })
    .from(collections)
    .innerJoin(
      revisionEntities,
      and(
        eq(revisionEntities.revisionId, collections.currentRevision),
        eq(revisionEntities.isRoot, true),
      ),
    )
    .innerJoin(
      entityVersions,
      eq(entityVersions.id, revisionEntities.entityVersionId),
    )
    .where(and(inJson(collections.id, ids), eq(collections.kind, 'profile')))
    .all()
  const found = new Map<string, string>()
  for (const row of rows) {
    let data: unknown = row.data
    if (typeof data === 'string')
      try {
        data = JSON.parse(data)
      } catch {
        continue
      }
    const username = (data as { username?: unknown } | null)?.username
    if (typeof username === 'string' && username) found.set(row.id, username)
  }
  return found
}

/** The newest finished page of a profile, whose next cursor reads on. */
function lastPage(db: Executor, collectionId: string) {
  return db
    .select()
    .from(captures)
    .where(
      and(
        eq(captures.collectionId, collectionId),
        eq(captures.isCollection, true),
        inArray(captures.state, ['complete', 'partial']),
      ),
    )
    .orderBy(desc(captures.createdAt), desc(captures.id))
    .limit(1)
    .get()
}

/** Whether a profile has older posts to read after its last page. */
function hasOlder(db: Executor, collectionId: string): boolean {
  return !!lastPage(db, collectionId)?.nextPageCursor
}

/**
 * A profile's following and followers counts as its newest capture read
 * them, for the sheet to tell which lists an update would skip.
 */
function profileCounts(
  ctx: CaptureContext,
  collectionId: string,
  adapterId: string,
): { following?: number; followers?: number } {
  const relations = ctx.platforms.byId(adapterId).relations
  if (!relations) return {}
  const row = ctx.db
    .select({
      metrics: captureMetrics.metrics,
      type: entities.kind,
      externalId: entities.externalId,
    })
    .from(collections)
    .innerJoin(revisions, eq(revisions.id, collections.currentRevision))
    .leftJoin(captureMetrics, eq(captureMetrics.captureId, revisions.captureId))
    .innerJoin(revisionEntities, eq(revisionEntities.revisionId, revisions.id))
    .innerJoin(
      entityVersions,
      eq(entityVersions.id, revisionEntities.entityVersionId),
    )
    .innerJoin(entities, eq(entities.id, entityVersions.entityId))
    .where(
      and(eq(collections.id, collectionId), eq(revisionEntities.isRoot, true)),
    )
    .get()
  const counts = row?.metrics?.[`${row?.type}/${row?.externalId}`]
  const read = (pointer: string) => {
    const value = counts?.[pointer]
    return typeof value === 'number' && Number.isSafeInteger(value)
      ? value
      : undefined
  }
  const following = read(relations.counts.following)
  const followers = read(relations.counts.followers)
  return {
    ...(following === undefined ? {} : { following }),
    ...(followers === undefined ? {} : { followers }),
  }
}

export interface UpdatePreview {
  posts: number
  profiles: number
  /** Profiles whose platform can list who they follow (抓关系网). */
  listable: number
  /** The folder's name. */
  name: string
  /** A single profile: its list sizes as last captured. */
  counts?: { following?: number; followers?: number }
  /** A single profile: whether there are older posts to read. */
  older?: boolean
}

/** What an update of a target would cover, for the sheet that starts it. */
export function previewUpdate(
  ctx: CaptureContext,
  input: UpdateTargetInput,
): UpdatePreview {
  const resolved = resolveTarget(ctx.db, input)
  const kinds = itemKinds(ctx.db, resolved.collectionIds)
  let posts = 0
  let profiles = 0
  let listable = 0
  for (const item of kinds.values()) {
    if (item.kind !== 'profile') {
      posts++
      continue
    }
    profiles++
    if (ctx.platforms.byId(item.adapterId).relations) listable++
  }
  const preview: UpdatePreview = {
    posts,
    profiles,
    listable,
    name: resolved.name,
  }
  const only = kinds.get(resolved.collectionIds[0]!)
  if (resolved.target === 'collection' && only?.kind === 'profile') {
    preview.counts = profileCounts(ctx, only.id, only.adapterId)
    preview.older = hasOlder(ctx.db, only.id)
  }
  return preview
}

// --- Running ----------------------------------------------------------------

/**
 * Update a target: capture each collection it holds again, as one record.
 * Each is captured as a link submission with the same options would be;
 * `older` reads profiles on from their last page. Returns the update's id.
 */
export function startUpdate(
  ctx: CaptureContext,
  input: UpdateTargetInput,
  options: UpdateOptions = {},
): string {
  if (options.key && options.key.length > 200)
    throw new AppError('invalid_request', '请求标识过长')
  const captureOptions = options.options ?? DEFAULT_OPTIONS
  checkOptions(captureOptions)
  return ctx.db.transaction((tx) => {
    if (options.key) {
      const existing = tx
        .select({ id: updates.id })
        .from(updates)
        .where(eq(updates.idemKey, options.key))
        .get()
      if (existing) return existing.id
    }
    const resolved = resolveTarget(tx, input)
    if (options.older) {
      const only = itemKinds(tx, resolved.collectionIds).get(
        resolved.collectionIds[0]!,
      )
      if (
        resolved.target !== 'collection' ||
        only?.kind !== 'profile' ||
        captureOptions.posts === 'none'
      )
        throw new AppError('unsupported')
      if (!hasOlder(tx, only.id)) throw new AppError('no_more_pages')
    }
    const id = newId()
    tx.insert(updates)
      .values({
        id,
        target: resolved.target,
        targetId: resolved.targetId,
        name: resolved.name,
        collectionIds: resolved.collectionIds,
        options: captureOptions,
        older: options.older ?? false,
        idemKey: options.key ?? null,
        ...(options.watchId
          ? { origin: 'watch' as const, watchId: options.watchId }
          : {}),
        createdAt: new Date(ctx.now?.() ?? Date.now()),
      })
      .run()
    ctx.queue.enqueue(tx, 'update', id, { updateId: id })
    return id
  })
}

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
  const items = itemRows(ctx.db, [id])
  for (const { submission, capture } of items)
    if (capture.isCollection && !submission.collectionStopped)
      stopCollection(ctx, submission.id)
  for (const fetch of ctx.db
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
    .all())
    failRelations(ctx, fetch.id, '已中止')
}

/**
 * Pause an update: it submits no further items, and its waiting jobs (the
 * captures, pages, downloads it queued) are not taken until it resumes.
 * Jobs already running finish. A finished or stopped update cannot pause.
 */
export function pauseUpdate(ctx: CaptureContext, id: string): void {
  const update = loadUpdate(ctx.db, id)
  if (update.pausedAt) return
  if (
    !['running', 'complete'].includes(update.state) ||
    updateRecord(ctx.db, id).done
  )
    throw new AppError('unsupported')
  ctx.db.transaction((tx) => {
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

/** Start the same update again, as a new record. */
export function repeatUpdate(ctx: CaptureContext, id: string): string {
  const update = loadUpdate(ctx.db, id)
  const options = { options: update.options, older: update.older }
  if (update.target === 'many')
    return startUpdate(
      ctx,
      {
        target: 'many',
        ids: [...savedIds(ctx.db, update.collectionIds)],
      },
      options,
    )
  return startUpdate(
    ctx,
    { target: update.target, id: update.targetId },
    options,
  )
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
): void {
  const update = loadUpdate(ctx.db, id)
  const [g] = gather(ctx.db, [update])
  const root = g!.items.find(
    (i) =>
      i.capture.collectionId === collectionId &&
      g!.roots.includes(i.submission.id),
  )
  if (!root) throw new AppError('not_found')
  const last = g!.pages.get(root.submission.id)?.at(-1)
  if (update.state === 'stopped' || !last) throw new AppError('unsupported')
  withOrigin({ updateId: id }, () => continuePages(ctx, last))
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
  /** Its username, when its saved version has one. */
  handle: string
  /** The profile's own capture; `waiting` before its turn, `skipped` if none. */
  state: string
  error: string
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

/** Captures of an update by state, with new and updated among the finished. */
function memberCounts(db: Executor, g: Gathered) {
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

/** What of an update's own row a kept record must still match. */
const updateStamp = (row: Update) =>
  JSON.stringify([
    row.state,
    row.position,
    row.skipped,
    row.error,
    row.pausedAt?.getTime(),
  ])

export function updateRecords(db: Executor, rows: Update[]): UpdateRecord[] {
  // Finished updates kept on a read thread are not counted again.
  const kept = new Map<string, UpdateRecord>()
  for (const row of rows) {
    const record = keptRecord<UpdateRecord>(row.id, updateStamp(row))
    if (record) kept.set(row.id, record)
  }
  const counted = new Map(
    gather(
      db,
      rows.filter((row) => !kept.has(row.id)),
    ).map((g) => [g.update.id, toUpdateRecord(db, g)]),
  )
  return rows.map((row) => {
    const record = kept.get(row.id) ?? counted.get(row.id)!
    if (record.done && !kept.has(row.id))
      keepRecord(row.id, updateStamp(row), record)
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
  const names = handles(
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
  return positions.map(({ id, position }) => {
    const item = byPosition.get(position)
    const url = kinds.get(id)!.url
    const skip = skips.get(position)
    if (!item)
      return {
        collectionId: id,
        url,
        handle: names.get(id) ?? '',
        state: position < update.position ? 'skipped' : 'waiting',
        error: skip ? SKIP_TEXT[skip.reason] : '',
        jobId: '',
        retryable: false,
      }
    const progress = progresses.get(item.submission.id)
    const relations = g.relations.get(item.submission.id)
    const collection = item.capture.collectionId
    return {
      collectionId: collection,
      url,
      handle: names.get(id) ?? '',
      state: item.capture.state,
      error: item.capture.error,
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
  if (record.kind !== 'profile') return []
  const row = recordRow(db, record.id)
  if (!row.capture.isCollection) return []
  const progress =
    row.submission.relatedState === 'none'
      ? undefined
      : collectionProgress(db, record.id)
  const options = storedOptions(row.submission.captureOptions)
  return [
    {
      collectionId: row.collection.id,
      url: row.collection.url,
      handle: handles(db, [row.collection.id]).get(row.collection.id) ?? '',
      state: row.capture.state,
      error: row.capture.error,
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
  const [g] = gather(db, [loadUpdate(db, id)])
  const record = toUpdateRecord(db, g!)
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
      pages
        .filter((p) => p.submission.relatedState === 'failed')
        .map((p) => p.submission.relatedError),
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
  const names = handles(
    db,
    g!.items.map((i) => i.capture.collectionId),
  )
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
      ...(names.has(capture.collectionId)
        ? { handle: names.get(capture.collectionId) }
        : {}),
    }
  })
  // Items skipped when their turn came, each with why; one still saved
  // links to its page.
  const skipped = skipRows(db, id)
  const stillSaved = savedIds(
    db,
    skipped.map((s) => s.collectionId),
  )
  const skips = skipped.map((skip): CaptureMember => ({
    jobId: `skipped:${skip.position}`,
    collectionId: skip.collectionId,
    saved: stillSaved.has(skip.collectionId),
    url: skip.url,
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
  ctx: CaptureContext,
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
  const requests = requestRecords(db, after, limit)
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
