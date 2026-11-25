import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { jobs } from '#db/schema.ts'
import type { Database } from '#db/client.ts'
import type { WorkerReport } from '#runtime/status-file.ts'
import type { WebLoadReport } from './load.ts'
import type { Env } from './validate.ts'

export interface QueueInfo {
  /** The worker's last report; undefined when it has not reported lately. */
  worker: () => WorkerReport | undefined
  /** This (web) process's last minute. */
  web?: () => WebLoadReport
}

/** Jobs waiting and running, per type. */
function backlog(db: Database) {
  return db
    .all<{ type: string; waiting: number; running: number }>(
      sql`SELECT ${jobs.type} AS type,
        count(*) FILTER (WHERE ${jobs.state} = 'available') AS waiting,
        count(*) FILTER (WHERE ${jobs.state} = 'running') AS running
      FROM ${jobs} GROUP BY ${jobs.type} ORDER BY ${jobs.type}`,
    )
    .map((row) => ({
      type: row.type,
      waiting: Number(row.waiting),
      running: Number(row.running),
    }))
}

/**
 * 管理员面板 → 后台任务: what the worker is doing and how far behind it is,
 * and the web process's latency.
 */
export function queueRoutes(db: Database, info: QueueInfo) {
  const view = () => {
    const worker = info.worker()
    return {
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
  return new Hono<Env>().get('/', (c) => c.json(view()))
}
