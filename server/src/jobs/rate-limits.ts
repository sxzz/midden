import { and, asc, eq, gt, isNotNull, ne, sql } from 'drizzle-orm'
import { jobs, rateLimits } from '#db/schema.ts'
import type { Executor } from '#db/client.ts'

/**
 * APIs that rate-limited us, kept in the database so the limits outlast
 * restarts and the web process can show them. Nothing is limited ahead of
 * time: a scope is limited only once its API answered that it was. The
 * worker's jobs then wait for the end (`RateLimitError` in `queue.ts`), and
 * requests to the scope are answered here without going out
 * (`#platforms/upstream.ts`).
 */

/** A rate limit's end and why, as one answer reported it. */
export interface RateLimitHit {
  scope: string
  /** Epoch ms. */
  until: number
  reason: string
}

export interface RateLimit {
  scope: string
  until: Date
  reason: string
  hits: number
  since: Date
  /** Jobs waiting for it. */
  waiting: number
}

/** When the scope's limit ends (epoch ms), while it lasts. */
export function limitedUntil(
  db: Executor,
  scope: string,
  now: number,
): number | undefined {
  const until = db
    .select({ until: rateLimits.until })
    .from(rateLimits)
    .where(eq(rateLimits.scope, scope))
    .get()?.until
  return until && until.getTime() > now ? until.getTime() : undefined
}

/**
 * Record a rate-limited answer. Within a limit that still lasts it counts
 * another hit, and the end moves only later; after one ended, a new limit
 * starts.
 */
export function recordRateLimit(
  db: Executor,
  hit: RateLimitHit,
  now: number,
): void {
  const live = sql`${rateLimits.until} > ${now}`
  db.insert(rateLimits)
    .values({
      scope: hit.scope,
      until: new Date(hit.until),
      reason: hit.reason,
      hits: 1,
      since: new Date(now),
    })
    .onConflictDoUpdate({
      target: rateLimits.scope,
      set: {
        hits: sql`CASE WHEN ${live} THEN ${rateLimits.hits} + 1 ELSE 1 END`,
        since: sql`CASE WHEN ${live} THEN ${rateLimits.since} ELSE excluded.since END`,
        until: sql`CASE WHEN ${live} THEN max(${rateLimits.until}, excluded.until) ELSE excluded.until END`,
        reason: sql`excluded.reason`,
      },
    })
    .run()
}

/** Limits that still last, soonest end first, with their waiting jobs. */
export function activeRateLimits(db: Executor, now: number): RateLimit[] {
  const waiting = new Map(
    db
      .select({ scope: jobs.rateScope, n: sql<number>`count(*)` })
      .from(jobs)
      .where(and(isNotNull(jobs.rateScope), ne(jobs.state, 'running')))
      .groupBy(jobs.rateScope)
      .all()
      .map((row) => [row.scope!, Number(row.n)]),
  )
  return db
    .select()
    .from(rateLimits)
    .where(gt(rateLimits.until, new Date(now)))
    .orderBy(asc(rateLimits.until), asc(rateLimits.scope))
    .all()
    .map((row) => ({ ...row, waiting: waiting.get(row.scope) ?? 0 }))
}

/**
 * End a limit now (the owner's 解除): its jobs are due at once. Returns
 * whether it was limited.
 */
export function clearRateLimit(
  db: Executor,
  scope: string,
  now: number,
): boolean {
  const { changes } = db
    .update(rateLimits)
    .set({ until: new Date(now) })
    .where(
      and(eq(rateLimits.scope, scope), gt(rateLimits.until, new Date(now))),
    )
    .run()
  db.update(jobs)
    .set({ runAt: new Date(now), rateScope: null })
    .where(eq(jobs.rateScope, scope))
    .run()
  return Number(changes) > 0
}
