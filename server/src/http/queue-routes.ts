import { inArray, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import { connections, jobs } from '#db/schema.ts'
import { readJobControl, writeJobControl } from '#jobs/control.ts'
import { PAUSABLE_TYPES } from '#jobs/queue.ts'
import { activeRateLimits, clearRateLimit } from '#jobs/rate-limits.ts'
import { inline } from './offload.ts'
import { json, type Env } from './validate.ts'
import type { Database } from '#db/client.ts'
import type { WorkerReport } from '#runtime/report.ts'
import type { WebLoadReport } from './load.ts'

export interface QueueInfo {
  /** The worker's report; undefined when it did not answer. */
  worker: () => Promise<WorkerReport | undefined>
  /** This (web) process's last minute. */
  web?: () => WebLoadReport
}

/** Jobs waiting, running and paused, per type. */
function backlog(db: Database) {
  return db
    .all<{ type: string; waiting: number; running: number; paused: number }>(
      sql`SELECT ${jobs.type} AS type,
        count(*) FILTER (WHERE ${jobs.state} = 'available') AS waiting,
        count(*) FILTER (WHERE ${jobs.state} = 'running') AS running,
        count(*) FILTER (WHERE ${jobs.state} = 'paused') AS paused
      FROM ${jobs} GROUP BY ${jobs.type} ORDER BY ${jobs.type}`,
    )
    .map((row) => ({
      type: row.type,
      waiting: Number(row.waiting),
      running: Number(row.running),
      paused: Number(row.paused),
    }))
}

/**
 * APIs that rate-limited us and have not reset yet, each with what it is
 * (`fxtwitter:public`, `x:session:<account>:<endpoint>`,
 * `instagram:session:<account>`) and the account by name.
 */
function rateLimitsView(db: Database, now: number) {
  const limits = activeRateLimits(db, now).map((limit) => {
    const [platform = '', kind = '', ...rest] = limit.scope.split(':')
    const account = kind === 'session' ? (rest.shift() ?? '') : ''
    return { limit, platform, account, endpoint: rest.join(':') }
  })
  const ids = [...new Set(limits.map((l) => l.account).filter(Boolean))]
  const names = new Map(
    (ids.length
      ? db
          .select({
            id: connections.id,
            name: connections.name,
            username: connections.username,
          })
          .from(connections)
          .where(inArray(connections.id, ids))
          .all()
      : []
    ).map((row) => [row.id, row.username ? `@${row.username}` : row.name]),
  )
  return limits.map(({ limit, platform, account, endpoint }) => ({
    scope: limit.scope,
    platform,
    ...(account ? { account: names.get(account) ?? account } : {}),
    ...(endpoint ? { endpoint } : {}),
    until: limit.until.toISOString(),
    since: limit.since.toISOString(),
    hits: limit.hits,
    reason: limit.reason,
    waiting: limit.waiting,
  }))
}

/**
 * 管理员面板 → 后台任务: what the worker is doing and how far behind it is,
 * pausing all of it or some job types, the APIs that rate-limited us, and
 * the web process's latency.
 */
export function queueRoutes(
  db: Database,
  info: QueueInfo,
  now: () => number = Date.now,
) {
  const view = async () => {
    const worker = await info.worker()
    return {
      control: readJobControl(db),
      pausable: [...PAUSABLE_TYPES],
      backlog: backlog(db),
      rate_limits: rateLimitsView(db, now()),
      worker: worker
        ? {
            reported_at: new Date(worker.at).toISOString(),
            factor: worker.throttle.factor,
            pressure: worker.throttle.pressure,
            ...(worker.throttle.reason
              ? { reason: worker.throttle.reason }
              : {}),
            // Why the factor is below 1: the reading that last halved it.
            ...(worker.throttle.cause
              ? {
                  cause: {
                    signal: worker.throttle.cause.signal,
                    value: worker.throttle.cause.value,
                  },
                }
              : {}),
            running: worker.queue.running,
            limits: worker.queue.limits,
            idle: worker.queue.idle,
            ...(worker.queue.held ? { held: worker.queue.held } : {}),
          }
        : null,
      web: info.web?.() ?? null,
    }
  }
  return (
    new Hono<Env>()
      // With the worker's report and this process's load: answered here.
      .get('/', inline, async (c) => c.json(await view()))
      .put(
        '/control',
        json(
          v.strictObject({
            paused: v.optional(v.boolean()),
            types: v.optional(v.array(v.picklist(PAUSABLE_TYPES))),
          }),
        ),
        async (c) => {
          const input = c.req.valid('json')
          const control = readJobControl(db)
          writeJobControl(db, {
            paused: input.paused ?? control.paused,
            types: input.types ?? control.types,
          })
          return c.json(await view())
        },
      )
      // End a limit early (解除): its jobs run at once, and a request still
      // limited is answered with a new limit.
      .post(
        '/rate-limits/clear',
        json(v.strictObject({ scope: v.pipe(v.string(), v.maxLength(1024)) })),
        async (c) => {
          db.transaction((tx) =>
            clearRateLimit(tx, c.req.valid('json').scope, now()),
          )
          return c.json(await view())
        },
      )
  )
}
