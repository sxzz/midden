// The web process's side of slow queries (`slow.ts`): each one is logged
// (`slow query`) and kept in `slow_queries`, the last `KEEP`, which
// 管理员面板 → 后台任务 lists. Only slow ones are written, a few at a time
// a second later, without waiting for the write lock: a database busy
// enough to make queries slow should not also stall the web process. What
// cannot be written now is tried again with the next.
import { desc, sql } from 'drizzle-orm'
import { isBusy, type Database } from '#db/client.ts'
import { slowQueries } from '#db/schema.ts'
import type { Logger } from '#log.ts'
import type { SlowQuery } from './slow.ts'

/** Records kept in the table. */
export const KEEP = 500
/** Records waiting to be written; beyond this the oldest are dropped. */
const PENDING = 100
/** At most one log line this often; the rest are counted in the next. */
const LOG_EVERY = 2000

export class SlowQueryLog {
  readonly #db: Database
  readonly #logger: Logger
  readonly #busyTimeoutMs: number
  #pending: SlowQuery[] = []
  #timer: ReturnType<typeof setTimeout> | undefined
  #loggedAt = 0
  #skipped = 0

  constructor(options: {
    db: Database
    logger: Logger
    /** The connection's busy timeout, restored after each write. */
    busyTimeoutMs: number
  }) {
    this.#db = options.db
    this.#logger = options.logger
    this.#busyTimeoutMs = options.busyTimeoutMs
  }

  record(query: SlowQuery): void {
    const now = Date.now()
    if (now - this.#loggedAt >= LOG_EVERY) {
      this.#logger.warn(
        {
          route: query.route,
          query: query.query,
          sql: query.sql,
          params: query.params,
          ms: query.ms,
          rows: query.rows,
          ...(this.#skipped ? { skipped: this.#skipped } : {}),
        },
        'slow query',
      )
      this.#loggedAt = now
      this.#skipped = 0
    } else this.#skipped++
    this.#pending.push(query)
    if (this.#pending.length > PENDING) this.#pending.shift()
    this.#timer ??= setTimeout(() => {
      this.#timer = undefined
      this.flush()
    }, 1000)
    this.#timer.unref?.()
  }

  /** Write what is waiting, unless another writer holds the lock. */
  flush(): void {
    if (!this.#pending.length) return
    const rows = this.#pending
    const client = this.#db.$client
    client.exec('PRAGMA busy_timeout = 0')
    try {
      this.#db.transaction((tx) => {
        tx.insert(slowQueries)
          .values(rows.map((q) => ({ ...q, at: new Date(q.at) })))
          .run()
        tx.run(sql`DELETE FROM slow_queries
          WHERE id <= (SELECT max(id) FROM slow_queries) - ${KEEP}`)
      })
      this.#pending = this.#pending.slice(rows.length)
    } catch (error) {
      if (!isBusy(error)) throw error
      this.#timer ??= setTimeout(() => {
        this.#timer = undefined
        this.flush()
      }, 5000)
      this.#timer.unref?.()
    } finally {
      // PRAGMA takes no bound parameters; this is a number of ours.
      client.exec(`PRAGMA busy_timeout = ${Math.trunc(this.#busyTimeoutMs)}`)
    }
  }

  stop(): void {
    clearTimeout(this.#timer)
    this.#timer = undefined
    try {
      this.flush()
    } catch {}
  }
}

/** The newest slow queries, for 管理员面板 → 后台任务. */
export function listSlowQueries(db: Database, limit = 100) {
  return db
    .select()
    .from(slowQueries)
    .orderBy(desc(slowQueries.id))
    .limit(limit)
    .all()
    .map((row) => ({
      id: row.id,
      at: row.at.toISOString(),
      route: row.route,
      query: row.query,
      sql: row.sql,
      params: row.params,
      ms: row.ms,
      rows: row.rows,
    }))
}
