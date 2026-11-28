import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm'
import { newId } from '#db/id.ts'
import { identityRequests, jobs, submissions } from '#db/schema.ts'
import { AppError } from '#errors.ts'
import type { Executor, Transaction } from '#db/client.ts'
import type { Platform } from '#platforms/platform.ts'
import type { ResolveResponse } from '#platforms/protocol.ts'
import type { CaptureContext } from './context.ts'
import type { CaptureRecord, CaptureRecordDetail } from './records.ts'
import type { Job, SubmitInput } from './submit.ts'

/**
 * How profiles were once saved by handle (`handle:<lower case>`). Kept only
 * as aliases of the account a capture found (`collection_identity_aliases`)
 * and by platforms without `identity` (Instagram).
 */
export const HANDLE = 'handle:'

/** What an identity request submits once identified, but its link. */
export type IdentityInput = Omit<
  SubmitInput,
  | 'url'
  | 'key'
  | 'prefetch'
  | 'refreshId'
  | 'parentSubmission'
  | 'updateId'
  | 'submissionId'
  | 'createdAt'
>

type Row = typeof identityRequests.$inferSelect

/**
 * The one account of this platform whose newest stored version goes by the
 * handle (in any letter case), or '' when none or several do: a handle
 * passes from one account to another, and only a single owner is sure.
 * Read through `entity_versions_username`.
 */
export function accountByHandle(
  db: Executor,
  platform: string,
  handle: string,
): string {
  // Every version that went by the handle (`entity_versions_username`, the
  // expression exactly as indexed), kept when it is its account's newest
  // (`entity_versions_newest`, one seek each).
  const rows = db.all<{ id: string }>(sql`
    SELECT DISTINCT e.external_id AS id FROM entity_versions v
    JOIN entities e ON e.id = v.entity_id
    WHERE lower(v.data ->> '$.username') = ${handle.toLowerCase()}
      AND v.data ->> '$.username' IS NOT NULL
      AND e.platform = ${platform} AND e.kind = ${`${platform}.profile`}
      AND e.external_id NOT LIKE ${`${HANDLE}%`}
      AND v.id = (
        SELECT n.id FROM entity_versions n WHERE n.entity_id = v.entity_id
        ORDER BY n.created_at DESC, n.id DESC LIMIT 1)
    LIMIT 2`)
  return rows.length === 1 ? rows[0]!.id : ''
}

/**
 * Whose a handle is, as the library already knows: the one account stored
 * under it, else the account an earlier identification found (an alias),
 * unless that account goes by another name since. '' when unknown.
 */
export function knownAccount(
  db: Executor,
  platform: string,
  handle: string,
): string {
  const stored = accountByHandle(db, platform, handle)
  if (stored) return stored
  const lower = handle.toLowerCase()
  const alias = db.get<{ id: string; username: string | null }>(sql`
    SELECT c.external_id AS id, (
      SELECT lower(v.data ->> '$.username') FROM entities e
      JOIN entity_versions v ON v.entity_id = e.id
      WHERE e.platform = c.platform AND e.kind = ${`${platform}.profile`}
        AND e.external_id = c.external_id
      ORDER BY v.created_at DESC, v.id DESC LIMIT 1) AS username
    FROM collection_identity_aliases a
    JOIN collections c ON c.id = a.collection_id
    WHERE a.platform = ${platform} AND a.kind = 'profile'
      AND a.object_scope = '' AND a.external_id = ${`${HANDLE}${lower}`}
      AND c.external_id NOT LIKE ${`${HANDLE}%`}`)
  return alias && (alias.username ?? lower) === lower ? alias.id : ''
}

/** The job view of a request still being identified. */
export function identityJob(row: Row): Job {
  return {
    id: row.id,
    collectionId: '',
    state: row.state === 'failed' ? 'failed' : 'queued',
    error: row.error,
    providerId: row.request.providerId ?? '',
    connectionId: row.request.connectionId ?? '',
    accessScope: '',
    createdAt: row.createdAt,
    submissionId: row.id,
  }
}

/**
 * Ask for a profile its link names by handle: a request the `identify` job
 * turns into the submission of its account, under the same id. A repeat
 * with the same key returns it, or the submission it became.
 */
export function requestIdentity(
  ctx: CaptureContext,
  platform: Platform,
  target: ResolveResponse,
  request: SubmitInput & { key: string },
): Job {
  const {
    url,
    key,
    prefetch: _,
    refreshId: __,
    parentSubmission,
    updateId,
    submissionId: ___,
    createdAt: ____,
    ...rest
  } = request
  return ctx.db.transaction((tx) => {
    const existing = tx
      .select()
      .from(identityRequests)
      .where(eq(identityRequests.idemKey, key))
      .get()
    if (existing) return identityJob(existing)
    const made = tx
      .select({ id: submissions.id, captureId: submissions.captureId })
      .from(submissions)
      .where(eq(submissions.idemKey, key))
      .get()
    if (made) throw new AppError('conflict')
    const row = tx
      .insert(identityRequests)
      .values({
        id: newId(),
        idemKey: key,
        adapterId: platform.description.adapterId,
        url: target.url,
        handle: target.handle!,
        input: request.input || url || target.url,
        request: rest,
        parentSubmission: parentSubmission || null,
        updateId: updateId ?? null,
        createdAt: new Date(ctx.now?.() ?? Date.now()),
      })
      .returning()
      .get()
    ctx.queue.enqueue(tx, 'identify', row.id)
    return identityJob(row)
  })
}

/** Ask again for a failed request; its id stays the record's. */
export function retryIdentity(ctx: CaptureContext, id: string): string {
  return ctx.db.transaction((tx) => {
    const row = loadRequest(tx, id)
    if (!row) throw new AppError('not_found')
    if (row.state === 'failed') {
      tx.update(identityRequests)
        .set({ state: 'pending', error: '', finishedAt: null })
        .where(eq(identityRequests.id, id))
        .run()
      ctx.queue.enqueue(tx, 'identify', id)
    }
    return id
  })
}

export function loadRequest(db: Executor, id: string): Row | undefined {
  return db
    .select()
    .from(identityRequests)
    .where(eq(identityRequests.id, id))
    .get()
}

/** Record a request as failed for good, with why. */
export function failRequest(
  ctx: CaptureContext,
  tx: Transaction,
  id: string,
  error: string,
): void {
  tx.update(identityRequests)
    .set({
      state: 'failed',
      error,
      finishedAt: new Date(ctx.now?.() ?? Date.now()),
    })
    .where(eq(identityRequests.id, id))
    .run()
}

// --- As records ---------------------------------------------------------

/** A request being identified as the record it will become. */
export function identityRecord(db: Executor, row: Row): CaptureRecord {
  const failed = row.state === 'failed'
  const job = failed
    ? undefined
    : db
        .select({ attempt: jobs.attempt, scope: jobs.rateScope })
        .from(jobs)
        .where(and(eq(jobs.type, 'identify'), eq(jobs.ref, row.id)))
        .get()
  return {
    id: row.id,
    jobId: row.id,
    collectionId: '',
    saved: false,
    url: row.url,
    input: row.input,
    platform: row.adapterId,
    kind: 'profile',
    state: failed ? 'failed' : 'queued',
    ...(job
      ? {
          waiting: job.scope
            ? ('rate_limit' as const)
            : job.attempt > 0
              ? ('retry' as const)
              : ('queue' as const),
        }
      : {}),
    error: row.error,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
    media: { total: 0, ready: 0, failed: 0 },
    done: failed,
    retryable: 0,
    mediaRetryable: false,
  }
}

export function identityDetail(
  db: Executor,
  id: string,
): CaptureRecordDetail | undefined {
  const row = loadRequest(db, id)
  if (!row) return
  return {
    ...identityRecord(db, row),
    warnings: [],
    mediaItems: [],
    reasons: [],
  }
}

/** Top-level requests being identified, newest first, as records. */
export function identityRecords(
  db: Executor,
  after: { at: Date; id: string } | undefined,
  limit: number,
): CaptureRecord[] {
  return db
    .select()
    .from(identityRequests)
    .where(
      and(
        isNull(identityRequests.parentSubmission),
        sql`${identityRequests.input} <> ''`,
        after
          ? or(
              lt(identityRequests.createdAt, after.at),
              and(
                eq(identityRequests.createdAt, after.at),
                lt(identityRequests.id, after.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(identityRequests.createdAt), desc(identityRequests.id))
    .limit(limit)
    .all()
    .map((row) => identityRecord(db, row))
}
