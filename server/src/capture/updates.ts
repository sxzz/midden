import { and, desc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm'
import { newId } from '#db/id.ts'
import {
  assets,
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
  type UpdatePostMode,
  type UpdateTarget,
} from '#db/schema.ts'
import { inJson } from '#db/sql.ts'
import { AppError, isAppError } from '#errors.ts'
import { SnoozeError, type Job as QueueJob } from '#jobs/queue.ts'
import { parseFilterQuery } from '#library/filter-query.ts'
import { selectedIds } from '#library/list.ts'
import {
  captureWaits,
  collectionProgresses,
  decodeCursor,
  encodeCursor,
  failureReasons,
  isPending,
  isRetryablePage,
  memberPage,
  memberSubmissions,
  pageChains,
  recapture,
  RECORD_PAGE_SIZE,
  requestRecords,
  retryFailed,
  type CaptureMember,
  type CaptureRecord,
  type CaptureRecordDetail,
  type MemberProgress,
  type Page,
} from './records.ts'
import { stopCollection } from './related.ts'
import {
  failRelations,
  relationProgresses,
  type RelationProgress,
} from './relations.ts'
import { submit, type Job } from './submit.ts'
import type { Executor } from '#db/client.ts'
import type { CaptureContext } from './context.ts'
import type { CaptureOptions } from './options.ts'
import type { Metrics, Payload } from './payload.ts'

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
  posts?: UpdatePostMode
  relations?: boolean
  /** Idempotency key: a repeat returns the update it started. */
  key?: string
}

// --- Targets ----------------------------------------------------------------

interface Resolved {
  target: UpdateTarget
  targetId: string
  name: string
  collectionIds: string[]
}

function savedIds(db: Executor, ids: string[]): Set<string> {
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
    const ids = selectedIds(
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
function handles(db: Executor, ids: string[]): Map<string, string> {
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
      metrics: captures.metrics,
      type: entities.kind,
      externalId: entities.externalId,
    })
    .from(collections)
    .innerJoin(revisions, eq(revisions.id, collections.currentRevision))
    .innerJoin(captures, eq(captures.id, revisions.captureId))
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
  const counts = (row?.metrics as Metrics | null)?.[
    `${row?.type}/${row?.externalId}`
  ]
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
 * Profiles read their timeline as `posts` says and, with `relations`, their
 * following and followers lists. Returns the update's id.
 */
export function startUpdate(
  ctx: CaptureContext,
  input: UpdateTargetInput,
  options: UpdateOptions = {},
): string {
  if (options.key && options.key.length > 200)
    throw new AppError('invalid_request', '请求标识过长')
  const posts = options.posts ?? 'latest'
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
    if (posts === 'older') {
      const only = itemKinds(tx, resolved.collectionIds).get(
        resolved.collectionIds[0]!,
      )
      if (resolved.target !== 'collection' || only?.kind !== 'profile')
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
        posts,
        relations: options.relations ?? false,
        idemKey: options.key ?? null,
        createdAt: new Date(ctx.now?.() ?? Date.now()),
      })
      .run()
    ctx.queue.enqueue(tx, 'update', id)
    return id
  })
}

const POST_OPTIONS: Record<UpdatePostMode, CaptureOptions | undefined> = {
  // The timeline's first page, as any refresh of a profile reads it.
  latest: undefined,
  until_existing: { untilExisting: true },
  older: undefined,
  none: { skipPosts: true },
}

/** Submit one item of an update; undefined when it cannot be captured. */
function submitItem(
  ctx: CaptureContext,
  update: Update,
  position: number,
): Job | undefined {
  const collectionId = update.collectionIds[position]!
  const item = itemKinds(ctx.db, [collectionId]).get(collectionId)
  if (!item) return undefined
  const key = `update:${update.id}:${position}`
  try {
    if (item.kind !== 'profile')
      return recapture(ctx, collectionId, { key, updateId: update.id })
    if (update.posts === 'older') {
      const page = lastPage(ctx.db, collectionId)
      if (!page?.nextPageCursor) return undefined
      return submit(ctx, {
        url: item.url,
        providerId: page.providerId,
        connectionId: page.connectionId ?? undefined,
        pageCursor: page.nextPageCursor,
        key,
        updateId: update.id,
      })
    }
    return recapture(ctx, collectionId, {
      key,
      updateId: update.id,
      captureOptions: POST_OPTIONS[update.posts],
      relations: update.relations || undefined,
    })
  } catch (error) {
    if (
      isAppError(error) &&
      [
        'not_found',
        'unsupported',
        'connection',
        'account_required',
        'invalid_target',
        'no_more_pages',
      ].includes(error.kind)
    )
      return undefined
    throw error
  }
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
    if (running >= WINDOW) throw new SnoozeError(FEED_WAIT_MS)
    const position = update.position
    const submitted = submitItem(ctx, update, position)
    db.update(updates)
      .set({
        position: position + 1,
        ...(submitted ? {} : { skipped: update.skipped + 1 }),
      })
      .where(and(eq(updates.id, update.id), eq(updates.position, position)))
      .run()
    if (submitted && isPending(submitted.state)) running++
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

function loadUpdate(db: Executor, id: string): Update {
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

function itemRows(db: Executor, ids: string[]) {
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
  ctx.db
    .update(updates)
    .set({ state: 'stopped' })
    .where(
      and(eq(updates.id, id), inArray(updates.state, ['running', 'complete'])),
    )
    .run()
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

/** Start the same update again, as a new record. */
export function repeatUpdate(ctx: CaptureContext, id: string): string {
  const update = loadUpdate(ctx.db, id)
  const options = { posts: update.posts, relations: update.relations }
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
 * Fetch again the failed captures of a finished update, or just one: posts
 * and profiles it updated and posts of their timelines. Returns how many.
 */
export function retryUpdateFailed(
  ctx: CaptureContext,
  id: string,
  jobId?: string,
): number {
  const update = loadUpdate(ctx.db, id)
  const items = itemRows(ctx.db, [id])
  const roots = items
    .filter(
      (i) => i.capture.isCollection && i.submission.relatedState !== 'none',
    )
    .map((i) => i.submission.id)
  const pages = [...pageChains(ctx.db, roots).values()].flatMap((chain) =>
    chain.filter(isRetryablePage).map((p) => p.submission.id),
  )
  let count = retryFailed(ctx, pages, jobId)
  const failed = items.filter(
    (i) => i.capture.state === 'failed' && (!jobId || i.capture.id === jobId),
  )
  const gone = new Set(
    failed.length
      ? ctx.db
          .select({ id: collections.id })
          .from(collections)
          .where(
            and(
              inJson(
                collections.id,
                failed.map((i) => i.capture.collectionId),
              ),
              isNotNull(collections.sourceState),
            ),
          )
          .all()
          .map((row) => row.id)
      : [],
  )
  for (const item of failed) {
    if (gone.has(item.capture.collectionId)) continue
    // Frees the item's key and leaves the failed request out of the record.
    ctx.db
      .update(submissions)
      .set({ idemKey: `retried:${item.submission.id}`, updateId: null })
      .where(eq(submissions.id, item.submission.id))
      .run()
    if (submitItem(ctx, update, positionOf(item.submission))) count++
  }
  return count
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
  options: { posts: UpdatePostMode; relations: boolean }
  /** Items not submitted yet. */
  queued: number
  /** Items that could not be captured when their turn came. */
  skipped: number
}

export interface ProfilePart {
  collectionId: string
  url: string
  /** Its username, when its saved version has one. */
  handle: string
  /** The profile's own capture; `waiting` before its turn, `skipped` if none. */
  state: string
  error: string
  /** Its timeline posts, unless the update left them out. */
  posts?: { total: number; finished: number; pending: number; done: boolean }
  relations?: RelationProgress[]
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
      SELECT s.capture_id, s.library_added, 1 FROM submissions s
      WHERE s.update_id = ${g.update.id}
      UNION ALL
      SELECT s.capture_id, s.library_added, p.value ->> '$.retry'
      FROM json_each(${JSON.stringify(pages)}) p
      JOIN submissions s ON s.parent_submission = p.value ->> '$.id'
      WHERE s.idem_key LIKE 'related:%'
    ),
    captured AS (
      SELECT c.id AS id, c.collection_id AS collection, c.state AS state,
        c.created_at AS created, c.finished_at AS finished,
        max(src.added) AS added,
        max(src.retry AND c.state = 'failed' AND a.source_state IS NULL)
          AS retryable
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
    if (row.state === 'complete' || row.state === 'partial') {
      counts[row.state] += row.n
      counts.added += row.added
      counts.updated += row.updated
      counts.unknown += row.n - row.added - row.updated
    } else if (row.state === 'failed') counts.failed += row.n
    else if (isPending(row.state)) counts.pending += row.n
  }
  return counts
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
  const lists = [...g.relations.values()].flat()
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
    done,
    ...(counts.unknown ? {} : { added: counts.added, updated: counts.updated }),
  }
  const failedItems = g.items.filter((i) => i.capture.state === 'failed').length
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
    ...(done ? { retryable: counts.retryable } : {}),
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
      options: { posts: update.posts, relations: update.relations },
      queued,
      skipped: update.skipped,
    },
  }
}

export function updateRecords(db: Executor, rows: Update[]): UpdateRecord[] {
  return gather(db, rows).map((g) => toUpdateRecord(db, g))
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
  return positions.map(({ id, position }) => {
    const item = byPosition.get(position)
    const url = kinds.get(id)!.url
    if (!item)
      return {
        collectionId: id,
        url,
        handle: names.get(id) ?? '',
        state: position < update.position ? 'skipped' : 'waiting',
        error: '',
      }
    const progress = progresses.get(item.submission.id)
    const relations = g.relations.get(item.submission.id)
    return {
      collectionId: item.capture.collectionId,
      url,
      handle: names.get(id) ?? '',
      state: item.capture.state,
      error: item.capture.error,
      ...(update.posts !== 'none' && progress
        ? {
            posts: {
              total: progress.total,
              finished: progress.complete + progress.partial + progress.failed,
              pending: progress.pending,
              done: progress.done || progress.stopped,
            },
          }
        : {}),
      ...(relations ? { relations } : {}),
    }
  })
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
function newestPerCollection(
  listings: { submission: Submission; capture: Capture }[],
) {
  const newest = new Map<string, { submission: Submission; capture: Capture }>()
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
  const lists = fetches.map(({ fetch }): CaptureMember => {
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
      list: fetch.list,
      ...(names.has(capture.collectionId)
        ? { handle: names.get(capture.collectionId) }
        : {}),
    }
  })
  return memberPage(
    db,
    `update:${id}`,
    state,
    cursor,
    newestPerCollection([...g!.items, ...memberSubmissions(db, pages)]),
    lists,
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
