import { RateLimitError, SnoozeError } from '#jobs/queue.ts'
import { limitedUntil, recordRateLimit } from '#jobs/rate-limits.ts'
import { isProviderFailure, rateLimitedKey } from '#platforms/platform.ts'
import { FALLBACK_LIMIT_MS, RateGate } from '#platforms/upstream.ts'
import { retryAfter } from './errors.ts'
import type { CaptureContext } from './context.ts'

/**
 * Rate limits for one platform call of a job: requests to an API that
 * rate-limited us do not go out until its limit ends, and a 429 is
 * recorded for every job that asks the same API.
 */
export function rateGate(
  ctx: Pick<CaptureContext, 'db' | 'now'>,
  connectionId: string | null,
): RateGate {
  const now = () => ctx.now?.() ?? Date.now()
  return new RateGate(
    connectionId,
    {
      until: (scope) => limitedUntil(ctx.db, scope, now()),
      record: (hit) => recordRateLimit(ctx.db, hit, now()),
    },
    now,
  )
}

export function isRateLimited(error: unknown): boolean {
  return (
    isProviderFailure(error) && error.metadata.get(rateLimitedKey)[0] === '1'
  )
}

/**
 * What a call that failed for a rate limit waits for: the limit that ends
 * first of those it ran into, so that a call with another way to ask (the
 * other query of a list) goes on as soon as one opens. A limit only a
 * response's body reported (X's error 88 answers 200) is recorded here,
 * against the last request. Without a scope to name (the request was
 * another job's, shared) it still waits rather than use an attempt.
 */
export function rateLimitWait(
  gate: RateGate,
  error: unknown,
): RateLimitError | SnoozeError | undefined {
  if (!isRateLimited(error)) return
  let hits = gate.hits
  if (!hits.length && gate.last) {
    const hit = { ...gate.last, known: false }
    gate.store.record({
      ...gate.last,
      reason: error instanceof Error ? error.message : String(error),
    })
    hits = [hit]
  }
  if (!hits.length)
    return new SnoozeError(
      (retryAfter(error) ?? 0) * 1000 || FALLBACK_LIMIT_MS.public,
    )
  const first = hits.reduce((a, b) => (b.until < a.until ? b : a))
  // Only a limit met anew is worth a log entry of the call's requests.
  return new RateLimitError(
    first.scope,
    first.until,
    hits.some((hit) => !hit.known) ? { cause: error } : undefined,
  )
}
