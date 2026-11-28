import { Buffer } from 'node:buffer'
import { eq } from 'drizzle-orm'
import {
  collectionIdentityAliases,
  connections,
  identityRequests,
} from '#db/schema.ts'
import { isAppError } from '#errors.ts'
import { SnoozeError, type Job } from '#jobs/queue.ts'
import { traceUpstream } from '#platforms/upstream.ts'
import { classifyFailure, safeError } from './errors.ts'
import { holdConnection } from './fetch.ts'
import { failRequest, HANDLE, knownAccount, loadRequest } from './identity.ts'
import { rateGate, rateLimitWait } from './rate-limits.ts'
import { selectedConnection } from './records.ts'
import { submit } from './submit.ts'
import type { Transaction } from '#db/client.ts'
import type { Platform } from '#platforms/platform.ts'
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
 * submission of its profile (under the request's id). An alias remembers
 * the handle.
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
