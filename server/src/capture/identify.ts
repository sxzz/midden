import { Buffer } from 'node:buffer'
import { setTimeout as sleep } from 'node:timers/promises'
import { and, eq, sql } from 'drizzle-orm'
import { newId } from '#db/id.ts'
import {
  captures,
  collectionIdentityAliases,
  collections,
  connections,
  identityRequests,
} from '#db/schema.ts'
import { isAppError } from '#errors.ts'
import { SnoozeError, type Job } from '#jobs/queue.ts'
import { isProviderFailure, type Platform } from '#platforms/platform.ts'
import { traceUpstream } from '#platforms/upstream.ts'
import { classifyFailure, isPermanent, safeError } from './errors.ts'
import { holdConnection } from './fetch.ts'
import { failRequest, HANDLE, knownAccount, loadRequest } from './identity.ts'
import { failCapture } from './lifecycle.ts'
import { rateGate, rateLimitWait } from './rate-limits.ts'
import { dropAllSummaries } from './record-summaries.ts'
import { selectedConnection } from './records.ts'
import { submit, upsertCollection } from './submit.ts'
import type { Transaction } from '#db/client.ts'
import type { Credential } from '#platforms/protocol.ts'
import type { CaptureContext } from './context.ts'

const IDENTIFY_DEADLINE = 45_000

/**
 * Whose a handle is: what the library knows, else the platform's answer
 * (public first, then the account selected for the platform, if its
 * provider is the one `identity` asks), with the rate limits and the
 * one-request-at-a-time use of the account a capture has. A rate limit
 * throws what the job waits on.
 */
export async function identifyAccount(
  ctx: CaptureContext,
  platform: Platform,
  handle: string,
  job: Pick<Job, 'attempt' | 'maxAttempts'> & { signal?: AbortSignal },
  logged: Record<string, unknown>,
): Promise<string> {
  const identity = platform.identity!
  const adapterId = platform.description.adapterId
  const known = knownAccount(ctx.db, adapterId, handle)
  if (known) return known
  const connection = usableConnection(ctx, adapterId, identity.providerId)
  const gate = rateGate(ctx, connection?.id ?? null)
  let release = () => {}
  // Lent only if the public answer fails, and only while it is free.
  const account = connection
    ? (): Credential | undefined => {
        try {
          release = holdConnection(connection.id)
        } catch (error) {
          if (error instanceof SnoozeError) return undefined
          throw error
        }
        return { data: Buffer.from(ctx.openCredential(connection.ref)) }
      }
    : undefined
  const signal = AbortSignal.any([
    ...(job.signal ? [job.signal] : []),
    AbortSignal.timeout(IDENTIFY_DEADLINE),
  ])
  try {
    return await traceUpstream(
      {
        logger: ctx.logger.child({ ...logged, handle }),
        classify: (error) => classifyFailure(job, error),
        gate,
      },
      () => identity.identify(handle, signal, account),
    )
  } catch (error) {
    throw rateLimitWait(gate, error) ?? error
  } finally {
    release()
  }
}

/** The account selected for the platform, if `identity` may ask with it. */
function usableConnection(
  ctx: CaptureContext,
  adapterId: string,
  providerId: string,
): { id: string; ref: string } | undefined {
  const id = selectedConnection(ctx.db, adapterId)
  if (!id) return
  const row = ctx.db
    .select()
    .from(connections)
    .where(eq(connections.id, id))
    .get()
  return row?.state === 'ready' &&
    row.providerId === providerId &&
    row.credentialRef
    ? { id: row.id, ref: row.credentialRef }
    : undefined
}

/** Run an `identify` job: the request becomes its account's submission. */
export async function runIdentify(
  ctx: CaptureContext,
  job: Job,
): Promise<void> {
  const row = loadRequest(ctx.db, job.ref)
  if (row?.state !== 'pending') return
  const platform = ctx.platforms.byId(row.adapterId)
  const id = await identifyAccount(ctx, platform, row.handle, job, {
    jobId: job.id,
    jobType: job.type,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    requestId: row.id,
    platform: row.adapterId,
    target: { kind: 'profile', url: row.url },
  })
  identified(ctx, platform, row.id, id)
}

/**
 * Make the request what it asked for, now that the account is known: the
 * submission of its profile (under the request's id), or the fold of the
 * profile saved by handle it names. An alias remembers the handle.
 */
export function identified(
  ctx: CaptureContext,
  platform: Platform,
  requestId: string,
  account: string,
): void {
  const row = loadRequest(ctx.db, requestId)
  if (!row) return
  const target = platform.identity!.target(account)
  if (row.collectionId) {
    ctx.db.transaction((tx) => {
      const from = tx
        .select()
        .from(collections)
        .where(eq(collections.id, row.collectionId!))
        .get()
      if (from) foldProfile(ctx, tx, from, target, row.handle)
      tx.delete(identityRequests).where(eq(identityRequests.id, row.id)).run()
    })
    return
  }
  let collectionId: string | undefined
  try {
    collectionId = submit(ctx, {
      ...row.request,
      url: target.url,
      input: row.input,
      key: row.idemKey,
      parentSubmission: row.parentSubmission ?? undefined,
      updateId: row.updateId ?? undefined,
      submissionId: row.id,
      createdAt: row.createdAt,
    }).collectionId
  } catch (error) {
    // Its page was stopped meanwhile: nothing more to submit.
    if (!isAppError(error, 'collection_stopped')) throw error
  }
  ctx.db.transaction((tx) => {
    if (collectionId)
      alias(tx, platform.description.adapterId, row.handle, collectionId)
    tx.delete(identityRequests).where(eq(identityRequests.id, row.id)).run()
  })
}

/** A request out of attempts, or told outright there is no such account. */
export function failIdentify(
  ctx: CaptureContext,
  job: Job,
  error: unknown,
): void {
  ctx.db.transaction((tx) => failRequest(ctx, tx, job.ref, safeError(error)))
}

function alias(
  tx: Transaction,
  platform: string,
  handle: string,
  collectionId: string,
): void {
  const values = {
    platform,
    kind: 'profile',
    objectScope: '',
    externalId: `${HANDLE}${handle.toLowerCase()}`,
    collectionId,
  }
  tx.insert(collectionIdentityAliases)
    .values(values)
    .onConflictDoUpdate({
      target: [
        collectionIdentityAliases.platform,
        collectionIdentityAliases.kind,
        collectionIdentityAliases.objectScope,
        collectionIdentityAliases.externalId,
      ],
      set: { collectionId },
    })
    .run()
}

// --- Profiles saved by handle --------------------------------------------

type Collection = typeof collections.$inferSelect

/**
 * Fold a profile saved by its handle, before profiles were kept by id only,
 * into its account's collection (made if there is none): its captures and
 * records, library entry, tags, note, watch, shares, place in updates and
 * source states move there, then it goes. Only an empty one (no version)
 * is folded; the caller checks.
 */
export function foldProfile(
  ctx: CaptureContext,
  tx: Transaction,
  from: Collection,
  target: { url: string; externalId: string },
  handle: string,
): string {
  const to = upsertCollection(
    tx,
    {
      platform: from.platform,
      kind: from.kind,
      objectScope: from.objectScope,
      externalId: target.externalId,
      url: target.url,
    },
    from.providerId,
  )
  const f = from.id
  // A capture in flight that the account's collection already has its twin
  // of would break the one-active rule: it joins that one, as a capture
  // moved by `resolveCaptureScope` does.
  for (const { id } of tx.all<{ id: string }>(sql`
    SELECT c.id FROM captures c WHERE c.collection_id = ${f}
      AND c.state IN ('queued', 'downloading') AND c.revision_id IS NULL
      AND EXISTS (SELECT 1 FROM captures t WHERE t.collection_id = ${to}
        AND t.state IN ('queued', 'downloading') AND t.revision_id IS NULL
        AND t.adapter_id = c.adapter_id AND t.provider_id = c.provider_id
        AND coalesce(t.connection_id, '') = coalesce(c.connection_id, '')
        AND t.page_cursor = c.page_cursor AND t.page_size = c.page_size
        AND t.automatic = c.automatic)`))
    failCapture(ctx, tx, id, '已并入同一内容正在进行的采集')
  // Updates' kept progress is counted again from these.
  tx.run(sql`INSERT OR IGNORE INTO member_events (kind, ref)
    SELECT 'c', id FROM captures WHERE collection_id = ${f}`)
  tx.update(captures)
    .set({ collectionId: to })
    .where(eq(captures.collectionId, f))
    .run()
  tx.run(sql`INSERT INTO library
      (collection_id, provider_id, connection_id, adapter_id, note, created_at)
    SELECT ${to}, provider_id, connection_id, adapter_id, note, created_at
    FROM library WHERE collection_id = ${f}
    ON CONFLICT DO UPDATE SET note = excluded.note WHERE library.note = ''`)
  tx.run(sql`INSERT OR IGNORE INTO collection_tags (collection_id, tag_id)
    SELECT ${to}, tag_id FROM collection_tags WHERE collection_id = ${f}`)
  tx.run(sql`UPDATE watches SET collection_id = ${to}
    WHERE collection_id = ${f}
      AND NOT EXISTS (SELECT 1 FROM watches w WHERE w.collection_id = ${to})`)
  tx.run(sql`UPDATE shares SET target_id = ${to}
    WHERE target_kind = 'collection' AND target_id = ${f}`)
  tx.run(sql`UPDATE updates SET collection_ids = (
      SELECT json_group_array(CASE WHEN value = ${f} THEN ${to} ELSE value END)
      FROM json_each(updates.collection_ids))
    WHERE EXISTS (SELECT 1 FROM json_each(updates.collection_ids)
      WHERE value = ${f})`)
  tx.run(sql`UPDATE OR IGNORE update_members SET collection_id = ${to}
    WHERE collection_id = ${f}`)
  tx.run(sql`DELETE FROM update_members WHERE collection_id = ${f}`)
  tx.run(sql`UPDATE update_skips SET collection_id = ${to}
    WHERE collection_id = ${f}`)
  tx.run(sql`UPDATE submissions SET related_source_collection = ${to}
    WHERE related_source_collection = ${f}`)
  // What the platform said of it, unless the account's own says otherwise.
  if (
    !tx.get(
      sql`SELECT 1 AS x FROM collection_states WHERE collection_id = ${to}`,
    )
  ) {
    tx.run(sql`UPDATE collection_states SET collection_id = ${to}
      WHERE collection_id = ${f}`)
    tx.run(sql`UPDATE collections SET
        source_state = coalesce(source_state, ${from.sourceState}),
        source_state_at = coalesce(source_state_at, ${from.sourceStateAt?.getTime() ?? null})
      WHERE id = ${to}`)
  }
  tx.run(sql`UPDATE collections SET unreferenced_at = NULL
    WHERE id = ${to} AND EXISTS (SELECT 1 FROM library WHERE collection_id = ${to})`)
  tx.update(collectionIdentityAliases)
    .set({ collectionId: to })
    .where(eq(collectionIdentityAliases.collectionId, f))
    .run()
  tx.delete(collections).where(eq(collections.id, f)).run()
  alias(tx, from.platform, handle, to)
  // Records counted over the moved captures are counted again.
  dropAllSummaries(tx)
  return to
}

/** Lookups for a profile saved by handle before it is given up. */
export const FOLD_ATTEMPTS = 3
/** How far apart those lookups are. */
export const FOLD_SPACING_MS = 60 * 60_000
/** Lookups per pass, one a second. */
const FOLD_BUDGET = 30
const FOLD_PACE_MS = 1000

export interface SettleResult {
  /** Folded by what the library knows. */
  local: number
  /** Folded by the platform's answer. */
  identified: number
  /** Still waiting for another lookup. */
  waiting: number
  /** Given up on, left as failed requests. */
  failed: number
}

/**
 * Profiles saved by handle on platforms that keep profiles by id
 * (`identity`): fold each into its account's collection. What the library
 * knows needs no request; with `network`, up to FOLD_BUDGET others are
 * looked up, one a second and each at most every FOLD_SPACING_MS. One
 * still unknown after FOLD_ATTEMPTS lookups (or told outright there is no
 * such account) is logged and left as a failed request of its link, and
 * the collection leaves the library (maintenance removes it with its
 * captures). Ones with content are skipped and logged.
 */
export async function settleHandleProfiles(
  ctx: CaptureContext,
  {
    network = false,
    wait = (ms: number) => sleep(ms),
  }: { network?: boolean; wait?: (ms: number) => Promise<unknown> } = {},
): Promise<SettleResult> {
  const result: SettleResult = {
    local: 0,
    identified: 0,
    waiting: 0,
    failed: 0,
  }
  const now = () => ctx.now?.() ?? Date.now()
  const lookups: { request: string; collection: Collection }[] = []
  for (const platform of ctx.platforms.all()) {
    if (!platform.identity) continue
    const adapterId = platform.description.adapterId
    const rows = ctx.db
      .select()
      .from(collections)
      .where(
        and(
          eq(collections.platform, adapterId),
          eq(collections.kind, 'profile'),
          sql`${collections.externalId} LIKE ${`${HANDLE}%`}`,
        ),
      )
      .all()
    for (const collection of rows) {
      const handle = collection.externalId.slice(HANDLE.length)
      if (collection.currentRevision) {
        ctx.logger.warn(
          { collectionId: collection.id, externalId: collection.externalId },
          'profile saved by handle has content; not folded',
        )
        continue
      }
      const account = knownAccount(ctx.db, adapterId, handle)
      if (account) {
        ctx.db.transaction((tx) => {
          foldProfile(
            ctx,
            tx,
            collection,
            platform.identity!.target(account),
            handle,
          )
          tx.delete(identityRequests)
            .where(eq(identityRequests.collectionId, collection.id))
            .run()
        })
        result.local++
        continue
      }
      const request = pendingFold(ctx, collection, handle)
      if (!request) continue
      if (
        request.attempts > 0 &&
        now() - (request.finishedAt?.getTime() ?? 0) < FOLD_SPACING_MS
      ) {
        result.waiting++
        continue
      }
      lookups.push({ request: request.id, collection })
    }
  }
  if (!network) {
    result.waiting += lookups.length
    return result
  }
  for (const [index, { request, collection }] of lookups.entries()) {
    if (index >= FOLD_BUDGET) {
      result.waiting++
      continue
    }
    if (index) await wait(FOLD_PACE_MS)
    const platform = ctx.platforms.byId(collection.platform)
    const row = loadRequest(ctx.db, request)!
    let account: string
    try {
      account = await identifyAccount(
        ctx,
        platform,
        row.handle,
        { attempt: row.attempts + 1, maxAttempts: FOLD_ATTEMPTS },
        { collectionId: collection.id, requestId: row.id },
      )
    } catch (error) {
      // A rate limit ends this pass; the next one goes on.
      if (!isProviderFailure(error) && !isPermanent(error)) {
        result.waiting += lookups.length - index
        break
      }
      const attempts = row.attempts + 1
      if (isPermanent(error) || attempts >= FOLD_ATTEMPTS) {
        giveUp(ctx, collection, row.id, safeError(error))
        result.failed++
      } else {
        ctx.db
          .update(identityRequests)
          .set({
            attempts,
            error: safeError(error),
            finishedAt: new Date(now()),
          })
          .where(eq(identityRequests.id, row.id))
          .run()
        result.waiting++
      }
      continue
    }
    identified(ctx, platform, row.id, account)
    result.identified++
  }
  return result
}

/** The request that identifies a profile saved by handle, made once. */
function pendingFold(
  ctx: CaptureContext,
  collection: Collection,
  handle: string,
) {
  // Given up on, it stays a failed request until maintenance removes it.
  const found = ctx.db
    .select()
    .from(identityRequests)
    .where(eq(identityRequests.idemKey, `fold:${collection.id}`))
    .get()
  if (found)
    return found.state === 'pending' && found.collectionId ? found : undefined
  return ctx.db
    .insert(identityRequests)
    .values({
      id: newId(),
      idemKey: `fold:${collection.id}`,
      adapterId: collection.platform,
      url: collection.url,
      handle,
      // Not a record until it is given up on.
      input: '',
      request: {},
      collectionId: collection.id,
      createdAt: new Date(ctx.now?.() ?? Date.now()),
    })
    .returning()
    .get()
}

/**
 * A profile saved by handle no one could identify: its request shows as a
 * failed record of its link, and the collection leaves the library (with
 * its captures once maintenance removes it), so nothing stays under the
 * handle.
 */
function giveUp(
  ctx: CaptureContext,
  collection: Collection,
  requestId: string,
  error: string,
): void {
  ctx.logger.warn(
    {
      collectionId: collection.id,
      externalId: collection.externalId,
      url: collection.url,
      error,
    },
    'profile saved by handle could not be identified; left as a failed request',
  )
  const at = new Date(ctx.now?.() ?? Date.now())
  ctx.db.transaction((tx) => {
    tx.update(identityRequests)
      .set({
        state: 'failed',
        error,
        input: collection.url,
        collectionId: null,
        finishedAt: at,
      })
      .where(eq(identityRequests.id, requestId))
      .run()
    tx.run(sql`DELETE FROM library WHERE collection_id = ${collection.id}`)
    tx.update(collections)
      .set({ unreferencedAt: at })
      .where(
        and(
          eq(collections.id, collection.id),
          sql`${collections.unreferencedAt} IS NULL`,
        ),
      )
      .run()
    dropAllSummaries(tx)
  })
}
