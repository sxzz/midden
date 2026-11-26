import { sql } from 'drizzle-orm'
import { isBusy, type Database, type Executor } from '#db/client.ts'
import type { Logger } from '#log.ts'

/** Flushed this often: one write transaction a minute, whatever the traffic. */
export const USAGE_FLUSH_MS = 60_000
/** Days the usage view covers, today included. */
export const USAGE_DAYS = 30

/** A UTC day, YYYY-MM-DD. */
export const utcDay = (at: number) => new Date(at).toISOString().slice(0, 10)

export interface DayCount {
  day: string
  count: number
}

export interface EndpointCount {
  endpoint: string
  count: number
}

export interface TokenUsageSummary {
  today: number
  /** The last USAGE_DAYS days, oldest first, today last; zeros included. */
  days: DayCount[]
  total: number
}

/**
 * Requests per token, UTC day and endpoint. Counting is in memory; `flush`
 * adds the counts to `api_token_usage` and moves `last_used_at` in one
 * transaction, about once a minute, so a busy agent costs a few upserts a
 * minute rather than a write per request. Reads add what is not flushed
 * yet. Counts not flushed when the process dies are lost; they are only
 * statistics.
 */
export class TokenUsage {
  readonly #db: Database
  readonly #logger?: Logger
  readonly #now: () => number
  /** `token \n day \n endpoint` → count. */
  #counts = new Map<string, number>()
  #lastUsed = new Map<string, number>()
  #timer: ReturnType<typeof setInterval> | undefined

  constructor(options: { db: Database; logger?: Logger; now?: () => number }) {
    this.#db = options.db
    this.#logger = options.logger
    this.#now = options.now ?? Date.now
  }

  record(tokenId: string, endpoint: string): void {
    const now = this.#now()
    const key = `${tokenId}\n${utcDay(now)}\n${endpoint}`
    this.#counts.set(key, (this.#counts.get(key) ?? 0) + 1)
    this.#lastUsed.set(tokenId, now)
  }

  start(intervalMs = USAGE_FLUSH_MS): void {
    this.#timer ??= setInterval(() => this.flush(), intervalMs)
    this.#timer.unref()
  }

  /** Stop the timer and write what is left. */
  stop(): void {
    clearInterval(this.#timer)
    this.#timer = undefined
    this.flush()
  }

  /**
   * Write the counts so far. A token revoked meanwhile takes its counts with
   * it. When the database is busy the counts wait for the next flush.
   */
  flush(): void {
    if (!this.#counts.size && !this.#lastUsed.size) return
    const counts = this.#counts
    const lastUsed = this.#lastUsed
    this.#counts = new Map()
    this.#lastUsed = new Map()
    try {
      this.#db.transaction((tx) => {
        for (const [key, count] of counts) {
          const [token, day, endpoint] = key.split('\n') as [
            string,
            string,
            string,
          ]
          tx.run(sql`INSERT INTO api_token_usage (token_id, day, endpoint, count)
            SELECT ${token}, ${day}, ${endpoint}, ${count}
            WHERE EXISTS (SELECT 1 FROM api_tokens WHERE id = ${token})
            ON CONFLICT DO UPDATE SET count = count + excluded.count`)
        }
        for (const [token, at] of lastUsed)
          tx.run(sql`UPDATE api_tokens SET last_used_at = ${at}
            WHERE id = ${token} AND coalesce(last_used_at, 0) < ${at}`)
      })
    } catch (error) {
      // Put them back, for the next flush.
      for (const [key, count] of counts)
        this.#counts.set(key, (this.#counts.get(key) ?? 0) + count)
      for (const [token, at] of lastUsed)
        if ((this.#lastUsed.get(token) ?? 0) < at) this.#lastUsed.set(token, at)
      if (isBusy(error))
        this.#logger?.warn('token usage not written; the database is busy')
      else this.#logger?.error({ err: error }, 'token usage not written')
    }
  }

  /** Requests not flushed yet, by token and day. */
  #pending(tokenId: string): Map<string, number> {
    const days = new Map<string, number>()
    for (const [key, count] of this.#counts) {
      const [token, day] = key.split('\n', 2)
      if (token === tokenId) days.set(day!, (days.get(day!) ?? 0) + count)
    }
    return days
  }

  /** When the token was last used, flushed or not. */
  lastUsed(tokenId: string): number | undefined {
    return this.#lastUsed.get(tokenId)
  }

  /** Requests today (UTC), flushed or not. */
  today(db: Executor, tokenId: string): number {
    const day = utcDay(this.#now())
    const stored =
      db.get<{ n: number | null }>(
        sql`SELECT sum(count) AS n FROM api_token_usage
          WHERE token_id = ${tokenId} AND day = ${day}`,
      )?.n ?? 0
    return stored + (this.#pending(tokenId).get(day) ?? 0)
  }

  /** The last USAGE_DAYS days of each token, flushed or not. */
  summaries(db: Executor, tokenIds: readonly string[]) {
    const now = this.#now()
    const days = Array.from({ length: USAGE_DAYS }, (_, i) =>
      utcDay(now - (USAGE_DAYS - 1 - i) * 86_400_000),
    )
    const rows = db.all<{ token: string; day: string; n: number }>(
      sql`SELECT token_id AS token, day, sum(count) AS n FROM api_token_usage
        WHERE day >= ${days[0]} GROUP BY token_id, day`,
    )
    const out = new Map<string, TokenUsageSummary>()
    for (const id of tokenIds) {
      const byDay = this.#pending(id)
      for (const row of rows)
        if (row.token === id)
          byDay.set(row.day, (byDay.get(row.day) ?? 0) + row.n)
      const series = days.map((day) => ({ day, count: byDay.get(day) ?? 0 }))
      out.set(id, {
        today: series.at(-1)!.count,
        days: series,
        total: series.reduce((sum, d) => sum + d.count, 0),
      })
    }
    return out
  }

  /** The token's requests over the last USAGE_DAYS days, by endpoint. */
  endpoints(db: Executor, tokenId: string): EndpointCount[] {
    const since = utcDay(this.#now() - (USAGE_DAYS - 1) * 86_400_000)
    const counts = new Map<string, number>()
    for (const row of db.all<{ endpoint: string; n: number }>(
      sql`SELECT endpoint, sum(count) AS n FROM api_token_usage
        WHERE token_id = ${tokenId} AND day >= ${since} GROUP BY endpoint`,
    ))
      counts.set(row.endpoint, row.n)
    for (const [key, count] of this.#counts) {
      const [token, day, endpoint] = key.split('\n') as [string, string, string]
      if (token === tokenId && day >= since)
        counts.set(endpoint, (counts.get(endpoint) ?? 0) + count)
    }
    return [...counts]
      .map(([endpoint, count]) => ({ endpoint, count }))
      .toSorted(
        (a, b) =>
          b.count - a.count ||
          (a.endpoint < b.endpoint ? -1 : a.endpoint > b.endpoint ? 1 : 0),
      )
  }
}
