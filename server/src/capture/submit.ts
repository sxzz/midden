import { and, desc, eq, isNull, sql } from 'drizzle-orm'
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
import { checkOptions, type CaptureOptions } from './options.ts'
import type { Transaction } from '#db/client.ts'
import type { Buffer } from 'node:buffer'

export interface SubmitInput {
  url?: string
  /** What the user typed; defaults to the URL. */
  input?: string
  /** Refresh this saved collection through the source that saved it. */
  refreshId?: string
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
  options?: CaptureOptions
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
  checkOptions(input.options)
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

  if (
    target.collection &&
    !input.automatic &&
    input.options &&
    !input.pageCursor
  ) {
    input.collectionLimit = input.options.maxPosts ?? 0
    input.pageSize = Math.min(input.collectionLimit, 100)
  }
  const pageSize = input.pageSize ?? 0
  const collectionLimit = input.collectionLimit ?? 0
  if ((collectionLimit > 1000 && !input.options) || pageSize > 1000)
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
      options ??= (parent.options as CaptureOptions | null) ?? undefined
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
        ...(options ? [canonicalJson(options)] : []),
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

    // A refresh without an account keeps the collection it refreshes.
    let collectionId =
      input.refreshId && !connectionId ? input.refreshId : undefined
    collectionId ??= upsertCollection(tx, target, providerId)
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
          // Only a capture its listing created may skip asking upstream.
          prefetch: automatic && input.prefetch?.length ? input.prefetch : null,
        })
        .run()
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
        captureOptions: options ?? null,
      })
      .run()

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
