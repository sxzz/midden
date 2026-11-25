import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import type { WebLoadSignal } from '#jobs/throttle.ts'
import type { Logger } from '#log.ts'
import type { MiddlewareHandler } from 'hono'

/** The web process's recent responsiveness, for the admin page. */
export interface WebLoadReport {
  /** The period covered, in seconds. */
  window_s: number
  /** Event-loop delay, per-second p99 at its worst and the longest stall. */
  lag_p99_ms: number
  lag_max_ms: number
  requests: {
    count: number
    p50_ms: number | null
    p95_ms: number | null
    max_ms: number | null
    /** At or over the slow-request threshold. */
    slow: number
  }
}

interface LagSample {
  at: number
  p99: number
  max: number
}

interface RequestSample {
  at: number
  ms: number
}

const WINDOW = 60_000
const SIGNAL_WINDOW = 5000
const SAMPLE_EVERY = 1000
const MAX_REQUESTS = 10_000
/** At most one log line of a kind this often; the rest are counted. */
const LOG_EVERY = 10_000

/** Logs at most once per interval, telling how many were left out. */
class Sparse {
  #last = -Infinity
  #skipped = 0
  readonly #every: number

  constructor(every: number) {
    this.#every = every
  }

  /** The count of skipped lines to report, or undefined to skip this one. */
  take(now: number): number | undefined {
    if (now - this.#last < this.#every) {
      this.#skipped++
      return undefined
    }
    this.#last = now
    const skipped = this.#skipped
    this.#skipped = 0
    return skipped
  }
}

const round = (ms: number) => Math.round(ms)

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!
}

/**
 * Watches the web process: requests over `slowRequestMs` and event-loop
 * stalls over `lagMs` are logged (at most one line of each kind every 10 s,
 * with a count of the rest), and the last minute is kept for the admin page
 * and the worker's throttle.
 */
export class WebLoad {
  readonly #logger: Logger
  readonly #slowRequestMs: number
  readonly #lagMs: number
  readonly #now: () => number
  #lag: LagSample[] = []
  #requests: RequestSample[] = []
  #histogram: ReturnType<typeof monitorEventLoopDelay> | undefined
  #timer: NodeJS.Timeout | undefined
  readonly #slowLog = new Sparse(LOG_EVERY)
  readonly #lagLog = new Sparse(LOG_EVERY)

  constructor(options: {
    logger: Logger
    slowRequestMs?: number
    lagMs?: number
    now?: () => number
  }) {
    this.#logger = options.logger
    this.#slowRequestMs = options.slowRequestMs ?? 500
    this.#lagMs = options.lagMs ?? 200
    this.#now = options.now ?? Date.now
  }

  start(): void {
    if (this.#histogram) return
    this.#histogram = monitorEventLoopDelay({ resolution: 10 })
    this.#histogram.enable()
    this.#timer = setInterval(() => this.#sample(), SAMPLE_EVERY)
    this.#timer.unref()
  }

  stop(): void {
    clearInterval(this.#timer)
    this.#histogram?.disable()
    this.#histogram = undefined
  }

  #sample(): void {
    const histogram = this.#histogram
    if (!histogram) return
    // Nanoseconds; the timer's own resolution is included in each delay.
    const p99 = histogram.count ? histogram.percentile(99) / 1e6 : 0
    const max = histogram.count ? histogram.max / 1e6 : 0
    histogram.reset()
    this.recordLag(p99, max)
  }

  /** One second's event-loop delay. */
  recordLag(p99Ms: number, maxMs: number): void {
    const now = this.#now()
    this.#lag.push({ at: now, p99: p99Ms, max: maxMs })
    this.#lag = this.#lag.filter((s) => s.at > now - WINDOW)
    if (maxMs < this.#lagMs) return
    const skipped = this.#lagLog.take(now)
    if (skipped === undefined) return
    this.#logger.warn(
      { lagMs: round(maxMs), p99Ms: round(p99Ms), skipped },
      'event loop lag',
    )
  }

  /** One request's duration, from first byte in to the response. */
  recordRequest(
    ms: number,
    request: { method: string; path: string; status: number },
  ): void {
    const now = this.#now()
    this.#requests.push({ at: now, ms })
    let old = 0
    while (
      old < this.#requests.length &&
      this.#requests[old]!.at <= now - WINDOW
    )
      old++
    if (old || this.#requests.length > MAX_REQUESTS)
      this.#requests = this.#requests.slice(
        Math.max(old, this.#requests.length - MAX_REQUESTS),
      )
    if (ms < this.#slowRequestMs) return
    const skipped = this.#slowLog.take(now)
    if (skipped === undefined) return
    this.#logger.warn({ ...request, ms: round(ms), skipped }, 'slow request')
  }

  middleware(): MiddlewareHandler {
    return async (c, next) => {
      const started = performance.now()
      try {
        await next()
      } finally {
        this.recordRequest(performance.now() - started, {
          method: c.req.method,
          path: c.req.path,
          status: c.res.status,
        })
      }
    }
  }

  /** The last few seconds, for the worker's throttle. */
  signal(): WebLoadSignal {
    const since = this.#now() - SIGNAL_WINDOW
    const lag = this.#lag.filter((s) => s.at > since)
    return {
      lagP99Ms: round(Math.max(0, ...lag.map((s) => s.p99))),
      lagMaxMs: round(Math.max(0, ...lag.map((s) => s.max))),
      slowRequests: this.#requests.filter(
        (s) => s.at > since && s.ms >= this.#slowRequestMs,
      ).length,
    }
  }

  /** The last minute. */
  report(): WebLoadReport {
    const since = this.#now() - WINDOW
    const lag = this.#lag.filter((s) => s.at > since)
    const durations = this.#requests
      .filter((s) => s.at > since)
      .map((s) => s.ms)
      .toSorted((a, b) => a - b)
    const ms = (value: number | null) => (value === null ? null : round(value))
    return {
      window_s: WINDOW / 1000,
      lag_p99_ms: round(Math.max(0, ...lag.map((s) => s.p99))),
      lag_max_ms: round(Math.max(0, ...lag.map((s) => s.max))),
      requests: {
        count: durations.length,
        p50_ms: ms(percentile(durations, 0.5)),
        p95_ms: ms(percentile(durations, 0.95)),
        max_ms: ms(durations.at(-1) ?? null),
        slow: durations.filter((d) => d >= this.#slowRequestMs).length,
      },
    }
  }
}
