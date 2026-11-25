import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import * as v from 'valibot'
import { jobs } from '#db/schema.ts'
import { readJobControl, writeJobControl } from '#jobs/control.ts'
import { PAUSABLE_TYPES } from '#jobs/queue.ts'
import { json, type Env } from './validate.ts'
import type { Database } from '#db/client.ts'
import type { WorkerReport } from '#runtime/status-file.ts'
import type { WebLoadReport } from './load.ts'

export interface QueueInfo {
  /** The worker's last report; undefined when it has not reported lately. */
  worker: () => WorkerReport | undefined
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
 * 管理员面板 → 后台任务: what the worker is doing and how far behind it is,
 * pausing all of it or some job types, and the web process's latency.
 */
export function queueRoutes(db: Database, info: QueueInfo) {
  const view = () => {
    const worker = info.worker()
    return {
      control: readJobControl(db),
      pausable: [...PAUSABLE_TYPES],
      backlog: backlog(db),
      worker: worker
        ? {
            reported_at: new Date(worker.at).toISOString(),
            factor: worker.throttle.factor,
            pressure: worker.throttle.pressure,
            ...(worker.throttle.reason
              ? { reason: worker.throttle.reason }
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
  return new Hono<Env>()
    .get('/', (c) => c.json(view()))
    .put(
      '/control',
      json(
        v.strictObject({
          paused: v.optional(v.boolean()),
          types: v.optional(v.array(v.picklist(PAUSABLE_TYPES))),
        }),
      ),
      (c) => {
        const input = c.req.valid('json')
        const control = readJobControl(db)
        writeJobControl(db, {
          paused: input.paused ?? control.paused,
          types: input.types ?? control.types,
        })
        return c.json(view())
      },
    )
}
