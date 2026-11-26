import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import { newId } from '#db/id.ts'
import {
  captureRunning,
  captures,
  collections,
  connections,
  library,
  revisions,
  submissions,
} from '#db/schema.ts'
import { AppError } from '#errors.ts'
import {
  defaultProvider,
  provider as findProvider,
  supports,
} from '#platforms/registry.ts'
import { RELATED_FALLBACK_MS, type CaptureContext } from './context.ts'
import { canonicalJson, sha256Hex } from './json.ts'
import {
  budget,
  checkOptions,
  DEFAULT_OPTIONS,
  MAX_POSTS,
  startOptions,
  storedOptions,
  type StoredOptions,
} from './options.ts'
import { requestRelations } from './relations.ts'
import { stagePrefetch } from './staging.ts'
import type { Transaction } from '#db/client.ts'
import type { Buffer } from 'node:buffer'

export interface SubmitInput {
  url?: string
  /** What the user typed; defaults to the URL. */
  input?: string
  /** Refresh this saved collection through the source that saved it. */
  refreshId?: string
  /**
   * Fetch the target even when stored content would answer the request:
   * asking again for something saved means seeing it now. A refresh always
   * does.
   */
  refetch?: boolean
  connectionId?: string
  providerId?: string
  /** Idempotency key; a repeat with the same request returns the same job. */
  key?: string
  automatic?: boolean
  parentSubmission?: string
  pageCursor?: string
  pageSize?: number
  collectionLimit?: number
  /** For automatic targets: reuse stored content younger than this. */
  refreshAfterSeconds?: number
  prefetch?: Buffer
  /**
   * How a profile expands, what its timeline keeps and whether its lists
   * are fetched; a page or member without them inherits its parent's, a
   * top-level request without them gets the defaults.
   */
  options?: StoredOptions
  /** The update (更新) this request is an item of. */
  updateId?: string
}

export interface Job {
  id: string
  collectionId: string
  state: string
  error: string
  providerId: string
  connectionId: string
  accessScope: string
  createdAt: Date
  /** The submission this request created or matched. */
  submissionId: string
}

const MAX_CURSOR = 4096
const MAX_KEY = 200

export function jobView(
  tx: Transaction | CaptureContext['db'],
  captureId: string,
  submissionId: string,
): Job {
  const row = tx.select().from(captures).where(eq(captures.id, captureId)).get()
  if (!row) throw new AppError('not_found')
  return {
    id: row.id,
    collectionId: row.collectionId,
    state: row.state,
    error: row.error,
    providerId: row.providerId,
    connectionId: row.connectionId ?? '',
    accessScope: row.scope,
    createdAt: row.createdAt,
    submissionId,
  }
}

/**
 * Ask for a capture. Joins an identical capture in flight, or returns the
 * stored content when it is fresh enough; otherwise queues a new capture.
 * Every non-refresh submission saves its target in the library.
 */
export function submit(ctx: CaptureContext, request: SubmitInput): Job {
  const input = { ...request }
  if (input.options) checkOptions(input.options)
  const { db } = ctx

  if (input.refreshId) {
    const saved = db
      .select({
        url: collections.url,
        providerId: library.providerId,
        connectionId: library.connectionId,
      })
      .from(library)
      .innerJoin(collections, eq(collections.id, library.collectionId))
      .where(eq(library.collectionId, input.refreshId))
      .get()
    if (!saved) throw new AppError('not_found')
    input.url = saved.url
    input.providerId = saved.providerId
    input.connectionId = saved.connectionId ?? undefined
  }
  if (!input.url) throw new AppError('invalid_target')
  const { platform, target } = ctx.platforms.resolve(input.url)
  const adapterId = platform.description.adapterId

  if (input.connectionId) {
    const connection = db
      .select()
      .from(connections)
      .where(eq(connections.id, input.connectionId))
      .get()
    if (!connection || connection.adapterId !== adapterId)
      throw new AppError('connection')
    if (input.providerId && input.providerId !== connection.providerId)
      throw new AppError('connection')
    input.providerId = connection.providerId
  } else {
    let fallback: string | undefined
    try {
      fallback = defaultProvider(platform, 'none').id
    } catch (error) {
      if (error instanceof AppError && error.kind === 'account_required')
        throw error
      if (!input.providerId) throw error
    }
    input.providerId ||= fallback
  }
  const policy = findProvider(platform, input.providerId!)
  if (!supports(policy, 'capture.fetch')) throw new AppError('unsupported')
  const anonymous = policy.authentication === 'none'
  if (Boolean(input.connectionId) === anonymous)
    throw new AppError('connection')

  // A profile's first page starts the run its options budget.
  if (
    target.collection &&
    !input.automatic &&
    !input.pageCursor &&
    supports(policy, 'capture.page')
  )
    Object.assign(input, budget(ctx, input.options ?? DEFAULT_OPTIONS))
  const pageSize = input.pageSize ?? 0
  const collectionLimit = input.collectionLimit ?? 0
  if (collectionLimit > MAX_POSTS || pageSize > 1000)
    throw new AppError('unsupported')
  const pageCursor = input.pageCursor ?? ''
  if (
    pageCursor.length > MAX_CURSOR ||
    ((pageCursor || collectionLimit > 0 || pageSize > 0) &&
      (input.automatic ||
        !target.collection ||
        !supports(policy, 'capture.page')))
  )
    throw new AppError('unsupported')
  const userInput = input.input || input.url
  const key = input.key || newId()
  if (key.length > MAX_KEY)
    throw new AppError('invalid_request', '请求标识过长')
  const automatic = input.automatic ?? false
  const providerId = input.providerId!
  const connectionId = input.connectionId ?? ''

  return db.transaction((tx) => {
    // Members of a collection page are observed again with it.
    let recheck = false
    let options = input.options
    // The options as asked, before the run fixes its date cutoff.
    const asked = options
    if (input.parentSubmission) {
      const parent = tx
        .select({
          stopped: submissions.collectionStopped,
          isCollection: captures.isCollection,
          options: submissions.captureOptions,
        })
        .from(submissions)
        .innerJoin(captures, eq(captures.id, submissions.captureId))
        .where(eq(submissions.id, input.parentSubmission))
        .get()
      if (!parent) throw new AppError('not_found')
      recheck = parent.isCollection
      options ??= storedOptions(parent.options)
      if (parent.stopped) throw new AppError('collection_stopped')
    }
    if (connectionId) {
      const connection = tx
        .select({ state: connections.state })
        .from(connections)
        .where(
          and(
            eq(connections.id, connectionId),
            eq(connections.providerId, providerId),
          ),
        )
        .get()
      if (connection?.state !== 'ready') throw new AppError('connection')
    }
    const scope = connectionId ? `connection:${connectionId}` : 'public'
    const fingerprint = sha256Hex(
      [
        adapterId,
        target.platform,
        target.kind,
        target.objectScope,
        target.externalId,
        providerId,
        scope,
        input.refreshId ?? '',
        pageCursor,
        pageSize,
        collectionLimit,
        ...(asked ? [canonicalJson(asked)] : []),
        ...(input.updateId ? [`update:${input.updateId}`] : []),
      ].join('|'),
    )
    const existing = tx
      .select()
      .from(submissions)
      .where(eq(submissions.idemKey, key))
      .get()
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new AppError('conflict')
      return jobView(tx, existing.captureId, existing.id)
    }
    const stored = startOptions(
      options ?? DEFAULT_OPTIONS,
      ctx.now?.() ?? Date.now(),
    )

    // A refresh without an account keeps the collection it refreshes.
    let collectionId =
      input.refreshId && !connectionId ? input.refreshId : undefined
    collectionId ??= upsertCollection(tx, target, providerId)
    const libraryAdded = !holdsContent(tx, collectionId)
    if (!input.refreshId || input.refreshId === collectionId)
      tx.insert(library)
        .values({
          collectionId,
          providerId,
          connectionId: connectionId || null,
          adapterId,
        })
        .onConflictDoNothing()
        .run()
    tx.update(collections)
      .set({ unreferencedAt: null })
      .where(eq(collections.id, collectionId))
      .run()

    const explicitCollection = target.collection && !automatic
    let captureId = tx
      .select({ id: captures.id })
      .from(captures)
      .where(
        and(
          eq(captures.collectionId, collectionId),
          eq(captures.providerId, providerId),
          sql`coalesce(${captures.connectionId}, '') = ${connectionId}`,
          eq(captures.adapterId, adapterId),
          captureRunning,
          // A finished capture fetching its failed media again: not a fetch.
          isNull(captures.revisionId),
          eq(captures.pageCursor, pageCursor),
          eq(captures.pageSize, pageSize),
          // An explicit collection request expands; it never joins a capture
          // that will not.
          ...(explicitCollection ? [eq(captures.automatic, false)] : []),
        ),
      )
      .get()?.id

    if (
      !captureId &&
      !pageCursor &&
      !recheck &&
      !input.refreshId &&
      !input.refetch &&
      (automatic || !target.refreshOnSubmit)
    ) {
      const head = tx
        .select({
          captureId: revisions.captureId,
          observedAt: collections.observedAt,
        })
        .from(collections)
        .innerJoin(revisions, eq(revisions.collectionId, collections.id))
        .where(eq(collections.id, collectionId))
        .orderBy(desc(revisions.createdAt), desc(revisions.id))
        .limit(1)
        .get()
      const maxAge = (input.refreshAfterSeconds ?? 0) * 1000
      const now = ctx.now?.() ?? Date.now()
      if (head && (maxAge === 0 || head.observedAt.getTime() > now - maxAge))
        captureId = head.captureId
    }

    if (!captureId) {
      captureId = newId()
      tx.insert(captures)
        .values({
          id: captureId,
          collectionId,
          providerId,
          adapterId,
          scope,
          connectionId: connectionId || null,
          refreshFrom: input.refreshId || null,
          automatic,
          pageCursor,
          pageSize,
          isCollection: explicitCollection,
        })
        .run()
      // Only a capture its listing created may skip asking upstream.
      if (automatic && input.prefetch?.length)
        stagePrefetch(tx, captureId, input.prefetch)
      ctx.queue.enqueue(tx, 'capture', captureId)
    }

    const submissionId = newId()
    tx.insert(submissions)
      .values({
        id: submissionId,
        captureId,
        idemKey: key,
        fingerprint,
        input: userInput,
        collectionLimit,
        parentSubmission: input.parentSubmission || null,
        captureOptions: stored,
        libraryAdded,
        updateId: input.updateId ?? null,
      })
      .run()

    // Lists belong to the run, not to each of its pages.
    if (
      stored.relations &&
      explicitCollection &&
      !input.parentSubmission &&
      !pageCursor &&
      platform.relations
    )
      requestRelations(ctx, tx, submissionId, captureId)

    let expandRelated = !automatic
    if (
      automatic &&
      !target.collection &&
      !target.refreshOnSubmit &&
      input.parentSubmission
    ) {
      // A top-level request's or a collection page's direct child hydrates
      // its references; references of references never expand.
      const parent = tx
        .select({
          parent: submissions.parentSubmission,
          isCollection: captures.isCollection,
        })
        .from(submissions)
        .innerJoin(captures, eq(captures.id, submissions.captureId))
        .where(eq(submissions.id, input.parentSubmission))
        .get()
      expandRelated =
        !!parent && (parent.parent === null || parent.isCollection)
    }
    if (expandRelated && supports(policy, 'capture.related')) {
      tx.update(submissions)
        .set({
          relatedProvider: providerId,
          relatedConnection: connectionId || null,
          relatedAdapter: adapterId,
          relatedState: 'pending',
          relatedSourceCollection: collectionId,
        })
        .where(eq(submissions.id, submissionId))
        .run()
      const running = tx
        .select({ id: captures.id })
        .from(captures)
        .where(and(eq(captures.id, captureId), captureRunning))
        .get()
      ctx.queue.enqueue(tx, 'related', submissionId, {
        delayMs: running ? RELATED_FALLBACK_MS : 0,
      })
    }
    return jobView(tx, captureId, submissionId)
  })
}

/** One collection per platform object, whichever source stored it. */
export function upsertCollection(
  tx: Transaction,
  target: {
    platform: string
    kind: string
    objectScope: string
    externalId: string
    url: string
  },
  providerId: string,
): string {
  const found = tx
    .select({ id: collections.id })
    .from(collections)
    .where(
      and(
        eq(collections.platform, target.platform),
        eq(collections.kind, target.kind),
        eq(collections.objectScope, target.objectScope),
        eq(collections.externalId, target.externalId),
      ),
    )
    .get()
  if (found) return found.id
  const id = newId()
  tx.insert(collections)
    .values({
      id,
      platform: target.platform,
      kind: target.kind,
      objectScope: target.objectScope,
      externalId: target.externalId,
      url: target.url,
      providerId,
    })
    .run()
  return id
}

/** Whether a collection is in the library. */
export function isSaved(tx: Transaction, collectionId: string): boolean {
  return !!tx
    .select({ id: library.collectionId })
    .from(library)
    .where(eq(library.collectionId, collectionId))
    .get()
}

/**
 * Whether a collection is in the library with content. A library row alone
 * does not count: submitting inserts one before anything is fetched, and a
 * failed capture leaves it behind without content.
 */
export function holdsContent(tx: Transaction, collectionId: string): boolean {
  return !!tx
    .select({ id: library.collectionId })
    .from(library)
    .innerJoin(collections, eq(collections.id, library.collectionId))
    .where(
      and(
        eq(library.collectionId, collectionId),
        isNotNull(collections.currentRevision),
      ),
    )
    .get()
}

/** Start the removal clock of a collection nothing saves any more. */
export function markUnreferenced(
  tx: Transaction,
  collectionId: string,
  now: Date,
): void {
  tx.update(collections)
    .set({ unreferencedAt: now })
    .where(
      and(
        eq(collections.id, collectionId),
        isNull(collections.unreferencedAt),
        sql`NOT EXISTS (SELECT 1 FROM ${library} WHERE ${library.collectionId} = ${collections.id})`,
      ),
    )
    .run()
}
