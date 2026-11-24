import { Buffer } from 'node:buffer'
import { and, desc, eq, sql } from 'drizzle-orm'
import { newId } from '#db/id.ts'
import {
  captureRunning,
  captures,
  connections,
  entities,
  entityVersions,
  relationFetches,
  relationLists,
  revisionEntities,
  submissions,
  type RelationFetchState,
} from '#db/schema.ts'
import { inJson } from '#db/sql.ts'
import { RetryError, SnoozeError, type Job } from '#jobs/queue.ts'
import {
  isProviderFailure,
  rateLimitedKey,
  type RelationList,
} from '#platforms/platform.ts'
import { traceUpstream } from '#platforms/upstream.ts'
import { classifyFailure, retryAfter } from './errors.ts'
import { holdConnection, markReauth } from './fetch.ts'
import { valueAt } from './metrics.ts'
import { selectedConnection } from './records.ts'
import { observeEdges, storeListed } from './relation-store.ts'
import type { Executor, Transaction } from '#db/client.ts'
import type { CaptureContext } from './context.ts'
import type { Metrics } from './payload.ts'

/** A list longer than this is not fetched: too many requests for one update. */
export const RELATION_LIMIT = 5000
// Pages fetched per job run; the next run is a new job, so a rate limit late
// in a long list does not use up the attempts of the pages before it.
const PAGES_PER_RUN = 5
// A source that keeps handing out cursors stops here: 5000 accounts at the
// fewest X lists per page, with room to spare.
const MAX_PAGES = 400
const WAIT_MS = 3000

type Fetch = typeof relationFetches.$inferSelect

const finished = (state: RelationFetchState) =>
  !['waiting', 'running'].includes(state)

/**
 * The list fetched may miss a few accounts the profile counts (suspended or
 * deactivated ones are counted but not listed). More missing than this means
 * the listing stopped short, and the fetch is not complete.
 */
export const allowedShortfall = (expected: number) =>
  Math.max(5, Math.ceil(expected * 0.1))

/**
 * Ask for an account's following and followers lists along with its
 * profile capture: one fetch per list, each waiting for the capture, which
 * starts them when it ends (`deliveries`).
 */
export function requestRelations(
  ctx: CaptureContext,
  tx: Transaction,
  submissionId: string,
  captureId: string,
): void {
  const running = !!tx
    .select({ id: captures.id })
    .from(captures)
    .where(and(eq(captures.id, captureId), captureRunning))
    .get()
  for (const list of relationLists) {
    const id = newId()
    tx.insert(relationFetches)
      .values({
        id,
        submissionId,
        list,
        createdAt: new Date(ctx.now?.() ?? Date.now()),
      })
      .run()
    if (!running) ctx.queue.enqueue(tx, 'relations', id)
  }
}

function loadFetch(db: Executor, id: string): Fetch | undefined {
  return db
    .select()
    .from(relationFetches)
    .where(eq(relationFetches.id, id))
    .get()
}

function settle(
  db: Executor,
  id: string,
  state: RelationFetchState,
  error: string,
  now: Date,
  extra: Partial<Fetch> = {},
): void {
  db.update(relationFetches)
    .set({ ...extra, state, error, finishedAt: now })
    .where(
      and(
        eq(relationFetches.id, id),
        sql`${relationFetches.state} IN ('waiting', 'running')`,
      ),
    )
    .run()
}

/** Record a final failure; what was observed so far stays. */
export function failRelations(
  ctx: CaptureContext,
  id: string,
  message: string,
): void {
  settle(ctx.db, id, 'failed', message, new Date(ctx.now?.() ?? Date.now()))
}

/** The account a list is read with: the capture's own, else the selected. */
function listAccount(
  tx: Transaction,
  capture: { adapterId: string; connectionId: string | null },
  providerId: string,
) {
  for (const id of [
    capture.connectionId,
    selectedConnection(tx, capture.adapterId),
  ]) {
    if (!id) continue
    const connection = tx
      .select()
      .from(connections)
      .where(eq(connections.id, id))
      .get()
    if (
      connection?.state === 'ready' &&
      connection.providerId === providerId &&
      connection.adapterId === capture.adapterId &&
      connection.credentialRef
    )
      return connection
  }
}

/**
 * Once the profile capture finished, decide from the counts it read whether
 * the list is fetched, and from where: a public account's (`protected` is
 * `false` in the profile just fetched) without an account from the public
 * provider, any other with an account. Returns whether to go on.
 */
function begin(ctx: CaptureContext, fetch: Fetch): boolean {
  const now = new Date(ctx.now?.() ?? Date.now())
  return ctx.db.transaction((tx) => {
    const capture = fetch.submissionId
      ? tx
          .select({ capture: captures })
          .from(submissions)
          .innerJoin(captures, eq(captures.id, submissions.captureId))
          .where(eq(submissions.id, fetch.submissionId))
          .get()?.capture
      : undefined
    if (!capture) {
      settle(tx, fetch.id, 'failed', '采集请求已删除', now)
      return false
    }
    if (capture.state === 'queued' || capture.state === 'downloading')
      throw new SnoozeError(WAIT_MS)
    if (capture.state === 'failed' || !capture.revisionId) {
      settle(tx, fetch.id, 'failed', '账号资料抓取失败，未抓关系网', now)
      return false
    }
    const relations = ctx.platforms.byId(capture.adapterId).relations
    const root = tx
      .select({
        id: entities.id,
        type: entities.kind,
        externalId: entities.externalId,
        data: entityVersions.data,
      })
      .from(revisionEntities)
      .innerJoin(
        entityVersions,
        eq(entityVersions.id, revisionEntities.entityVersionId),
      )
      .innerJoin(entities, eq(entities.id, entityVersions.entityId))
      .where(
        and(
          eq(revisionEntities.revisionId, capture.revisionId),
          eq(revisionEntities.isRoot, true),
        ),
      )
      .get()
    if (!relations || !root) {
      settle(tx, fetch.id, 'failed', '平台不支持抓关系网', now)
      return false
    }
    const count = (capture.metrics as Metrics | null)?.[
      `${root.type}/${root.externalId}`
    ]?.[relations.counts[fetch.list]]
    const known = typeof count === 'number' && Number.isSafeInteger(count)
    const base = { entityId: root.id, expected: known ? count : null }
    if (!known) {
      settle(tx, fetch.id, 'skipped', '资料没有给出人数，未抓取', now, base)
      return false
    }
    if (count > RELATION_LIMIT) {
      settle(
        tx,
        fetch.id,
        'skipped',
        `超过 ${RELATION_LIMIT} 人，未抓取`,
        now,
        base,
      )
      return false
    }
    let source: { providerId: string; connectionId: string | null }
    if (valueAt(root.data, relations.protectedPath) === false)
      source = { providerId: relations.publicProviderId, connectionId: null }
    else {
      const account = listAccount(tx, capture, relations.providerId)
      if (!account) {
        settle(tx, fetch.id, 'failed', '抓关系网需要可用的采集账号', now, base)
        return false
      }
      source = { providerId: account.providerId, connectionId: account.id }
    }
    tx.update(relationFetches)
      .set({ ...base, ...source, state: 'running', startedAt: now })
      .where(
        and(
          eq(relationFetches.id, fetch.id),
          eq(relationFetches.state, 'waiting'),
        ),
      )
      .run()
    return true
  })
}

/** The open follows of a list seen since the fetch started. */
function seenSince(
  db: Executor,
  list: RelationList,
  subject: string,
  since: Date,
): number {
  const column = list === 'following' ? 'follower_id' : 'followee_id'
  return (
    db.get<{ n: number }>(
      sql`SELECT count(*) AS n FROM follow_edges
        WHERE ${sql.raw(column)} = ${subject} AND ended_at IS NULL
          AND last_seen_at >= ${since.getTime()}`,
    )?.n ?? 0
  )
}

/**
 * The listing ended. A complete one is the only evidence of a follow ending:
 * open follows of this list not seen since it started have ended.
 */
function conclude(
  tx: Transaction,
  fetch: Fetch,
  reachedEnd: boolean,
  now: Date,
): void {
  const subject = fetch.entityId!
  const started = fetch.startedAt!
  const seen = seenSince(tx, fetch.list, subject, started)
  const expected = fetch.expected ?? 0
  const complete = reachedEnd && expected - seen <= allowedShortfall(expected)
  if (complete) {
    const column = fetch.list === 'following' ? 'follower_id' : 'followee_id'
    tx.run(sql`UPDATE follow_edges SET ended_at = ${now.getTime()}
      WHERE ${sql.raw(column)} = ${subject} AND ended_at IS NULL
        AND last_seen_at < ${started.getTime()}`)
  }
  settle(
    tx,
    fetch.id,
    complete ? 'complete' : 'partial',
    complete
      ? ''
      : reachedEnd
        ? `只列出 ${seen} 人，少于资料中的 ${expected} 人，未据此判断取关`
        : '已达翻页上限',
    now,
    { fetched: seen, cursor: '' },
  )
}

/** Fetch the next pages of a list, storing each as it arrives. */
export async function runRelations(
  ctx: CaptureContext,
  job: Job,
): Promise<void> {
  let fetch = loadFetch(ctx.db, job.ref)
  if (!fetch || finished(fetch.state)) return
  if (fetch.state === 'waiting') {
    if (!begin(ctx, fetch)) return
    fetch = loadFetch(ctx.db, job.ref)!
    if (fetch.state !== 'running') return
  }
  const source = ctx.db
    .select({
      adapterId: captures.adapterId,
      providerId: captures.providerId,
      connectionId: captures.connectionId,
    })
    .from(submissions)
    .innerJoin(captures, eq(captures.id, submissions.captureId))
    .where(eq(submissions.id, fetch.submissionId ?? ''))
    .get()
  // A public account's lists are read without one.
  const connection = fetch.connectionId
    ? ctx.db
        .select()
        .from(connections)
        .where(eq(connections.id, fetch.connectionId))
        .get()
    : undefined
  if (!source) {
    failRelations(ctx, fetch.id, '采集请求已删除')
    return
  }
  if (
    fetch.connectionId &&
    (connection?.state !== 'ready' || !connection.credentialRef)
  ) {
    failRelations(ctx, fetch.id, '采集账号不可用，请重新授权')
    return
  }
  const platform = ctx.platforms.byId(source.adapterId)
  const relations = platform.relations!
  const subject = ctx.db
    .select({ externalId: entities.externalId })
    .from(entities)
    .where(eq(entities.id, fetch.entityId!))
    .get()
  if (!subject) {
    failRelations(ctx, fetch.id, '账号资料已删除')
    return
  }
  const credential = connection?.credentialRef
    ? { data: Buffer.from(ctx.openCredential(connection.credentialRef)) }
    : undefined
  const now = () => new Date(ctx.now?.() ?? Date.now())
  const logger = ctx.logger.child({
    jobId: job.id,
    jobType: job.type,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    relationFetchId: fetch.id,
    list: fetch.list,
    providerId: fetch.providerId,
    connectionId: fetch.connectionId,
  })
  const release = connection ? holdConnection(connection.id) : () => {}
  try {
    for (let i = 0; i < PAGES_PER_RUN; i++) {
      let page
      try {
        const req = {
          list: fetch.list,
          externalId: subject.externalId,
          cursor: fetch.cursor,
          providerId: fetch.providerId ?? relations.providerId,
          credential,
          logger,
        }
        page = await traceUpstream(
          { logger, classify: (error) => classifyFailure(job, error) },
          () => relations.list(req, job.signal),
        )
      } catch (error) {
        if (connection)
          markReauth(ctx, connection.id, connection.revision, error)
        const seconds = retryAfter(error)
        // Every way to ask is limited: waiting is not an attempt.
        if (
          seconds &&
          isProviderFailure(error) &&
          error.metadata.get(rateLimitedKey)[0] === '1'
        )
          throw new SnoozeError(seconds * 1000)
        if (seconds)
          throw new RetryError('来源平台暂时出错', seconds * 1000, {
            cause: error,
          })
        throw error
      }
      const done = ctx.db.transaction((tx) => {
        const current = loadFetch(tx, job.ref)
        if (current?.state !== 'running') return true
        const at = now()
        const ids = storeListed(ctx, tx, platform, page.accounts, source, at)
        observeEdges(tx, current.list, current.entityId!, [...ids.values()], at)
        const pages = current.pages + 1
        const ended = !page.nextCursor || page.nextCursor === current.cursor
        tx.update(relationFetches)
          .set({
            pages,
            cursor: page.nextCursor,
            fetched: seenSince(
              tx,
              current.list,
              current.entityId!,
              current.startedAt!,
            ),
          })
          .where(eq(relationFetches.id, current.id))
          .run()
        if (ended || pages >= MAX_PAGES) {
          conclude(tx, { ...current, pages }, ended, at)
          return true
        }
        return false
      })
      if (done) return
      fetch = loadFetch(ctx.db, job.ref)!
      if (job.signal.aborted) break
    }
  } finally {
    release()
  }
  ctx.queue.enqueue(ctx.db, 'relations', job.ref)
}

/** What a request's list fetches have done, for its record and job. */
export interface RelationProgress {
  list: RelationList
  state: RelationFetchState
  expected?: number
  fetched: number
  error?: string
}

/** The list fetches of each submission, following before followers. */
export function relationProgresses(
  db: Executor,
  submissionIds: readonly string[],
): Map<string, RelationProgress[]> {
  const out = new Map<string, RelationProgress[]>()
  if (!submissionIds.length) return out
  const rows = db
    .select()
    .from(relationFetches)
    .where(inJson(relationFetches.submissionId, submissionIds))
    .orderBy(desc(relationFetches.list))
    .all()
  for (const row of rows) {
    const items = out.get(row.submissionId!) ?? []
    items.push({
      list: row.list,
      state: row.state,
      ...(row.expected === null ? {} : { expected: row.expected }),
      fetched: row.fetched,
      ...(row.error ? { error: row.error } : {}),
    })
    out.set(row.submissionId!, items)
  }
  return out
}

/** The newest request of a capture that asked for its lists. */
export function captureRelations(
  db: Executor,
  captureId: string,
): RelationProgress[] | undefined {
  const latest = db
    .select({ id: submissions.id })
    .from(relationFetches)
    .innerJoin(submissions, eq(submissions.id, relationFetches.submissionId))
    .where(eq(submissions.captureId, captureId))
    .orderBy(desc(relationFetches.createdAt))
    .limit(1)
    .get()
  return latest ? relationProgresses(db, [latest.id]).get(latest.id) : undefined
}

export const relationsDone = (items: readonly RelationProgress[]) =>
  items.every((item) => finished(item.state))

/** Whether a request asked for lists, so a retry asks again. */
export function askedRelations(db: Executor, submissionId: string): boolean {
  return !!db
    .select({ id: relationFetches.id })
    .from(relationFetches)
    .where(eq(relationFetches.submissionId, submissionId))
    .get()
}
