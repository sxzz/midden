import { createServer } from 'node:http'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { runMaintenance } from '#capture/maintenance.ts'
import { optimize, unknownMigrations } from '#db/client.ts'
import { pruneSessions } from '#http/auth.ts'
import { prunePasskeys } from '#http/passkeys.ts'
import { currentJob, RANK, withOrigin } from '#jobs/queue.ts'
import { StorageUsage } from '#usage/storage.ts'
import { writeStatus, type WorkerReport } from './status-file.ts'
import type { WebLoadSignal } from '#jobs/throttle.ts'
import type { Runtime } from './context.ts'

export interface WorkerOptions {
  /** A short message to the owner. */
  notify: (text: string) => void
  /** How the web process has been doing; undefined when unknown. */
  webSignal: () => WebLoadSignal | undefined
}

export interface WorkerHandle {
  report: () => WorkerReport
}

const MAINTENANCE_INTERVAL = 60_000
const OPTIMIZE_INTERVAL = 6 * 60 * 60_000
const THROTTLE_STEP = 1000
const STATUS_EVERY = 2000
const SCHEMA_CHECK = 10_000
// A write transaction holding the lock this long, or waiting this long for
// it, is logged with the job it ran for (at most one line in 10 s).
const SLOW_HOLD = 200
const SLOW_WAIT = 1000
const LOG_EVERY = 10_000
// Between the batches of one long task: a moment while calm; under
// contention, longer than the busy handler's longest sleep (100 ms), so a
// waiting writer in the web process wakes up inside the gap.
const PACE_CALM = 2
const PACE_CONTENDED = 120

/**
 * The worker: runs the job queue and the timers (maintenance, storage
 * usage, statistics), adapting its concurrency to how the web process and
 * the write lock are doing. In the `worker` role it also answers its own
 * health check and writes its status file.
 */
export function startWorker(rt: Runtime, options: WorkerOptions): WorkerHandle {
  const { config, logger, db, ctx, cleanups } = rt
  const throttle = rt.throttle!
  const startedAt = Date.now()
  const timers: NodeJS.Timeout[] = []
  const every = (ms: number, fn: () => void) => {
    const timer = setInterval(fn, ms)
    timers.push(timer)
    return timer
  }
  cleanups.push(() => timers.forEach(clearInterval))

  ctx.pace = () =>
    sleep(throttle.state().pressure === 'calm' ? PACE_CALM : PACE_CONTENDED)

  let slowLogged = -Infinity
  let slowSkipped = 0
  db.$writes.onWrite = ({ waitMs, holdMs }) => {
    if (holdMs < SLOW_HOLD && waitMs < SLOW_WAIT) return
    const now = Date.now()
    if (now - slowLogged < LOG_EVERY) {
      slowSkipped++
      return
    }
    slowLogged = now
    logger.warn(
      {
        holdMs: Math.round(holdMs),
        waitMs: Math.round(waitMs),
        job: currentJob(),
        skipped: slowSkipped,
      },
      'slow write transaction',
    )
    slowSkipped = 0
  }

  // Each second: the throttle reads the web process's lag and this
  // process's own lock waits and lock holding.
  let stepped = performance.now()
  let factor = throttle.state().factor
  db.$writes.take()
  every(THROTTLE_STEP, () => {
    const now = performance.now()
    const state = throttle.step({
      web: options.webSignal(),
      writes: db.$writes.take(),
      elapsedMs: now - stepped,
    })
    stepped = now
    if (state.factor !== factor)
      logger.info(
        {
          factor: state.factor,
          pressure: state.pressure,
          reason: state.reason,
        },
        state.factor < factor ? 'worker slowing down' : 'worker speeding up',
      )
    factor = state.factor
  })

  ctx.queue.start()

  // A newer version migrated the database (it started while this one still
  // runs): stop taking jobs rather than write to a schema this code does not
  // know. The deploy replaces this process shortly.
  let schemaVersion = -1
  every(SCHEMA_CHECK, () => {
    try {
      const version = Number(
        Object.values(
          db.$client.prepare('PRAGMA schema_version').get() ?? {},
        )[0],
      )
      if (version === schemaVersion) return
      schemaVersion = version
      const unknown = unknownMigrations(db)
      if (unknown && !ctx.queue.status().held) {
        logger.error(
          { unknown },
          'a newer version migrated the database; no longer taking jobs',
        )
        ctx.queue.hold('the database has migrations this version does not know')
      }
    } catch (error) {
      logger.warn({ err: error }, 'schema check failed')
    }
  })

  const storage = new StorageUsage({
    db,
    dataDir: config.dataDir,
    databasePath: config.databasePath,
    mediaDir: config.mediaDir,
    cloudflare: config.cloudflare,
    logger,
    notify: options.notify,
    // The daily composition reads every page in one read transaction, which
    // holds the WAL back meanwhile: only while the worker is idle.
    composeWhen: () => ctx.queue.status().idle,
  })
  let maintaining = false
  every(MAINTENANCE_INTERVAL, () => {
    if (maintaining) return
    maintaining = true
    // Jobs maintenance enqueues (thumbnails it backfills) come last.
    withOrigin({ rank: RANK.maintenance, updateId: null }, () => {
      try {
        pruneSessions(db)
        prunePasskeys(db)
      } catch (error) {
        logger.error({ err: error }, 'pruning sessions failed')
      }
      runMaintenance(ctx, { slim: ctx.queue.status().idle })
        .catch(() => {})
        .finally(() => (maintaining = false))
    })
    // Paced by itself: every 15 minutes, and the composition once a day.
    storage
      .tick()
      .catch((error: unknown) =>
        logger.error({ err: error }, 'storage usage failed'),
      )
  })
  every(OPTIMIZE_INTERVAL, () => {
    try {
      optimize(db)
    } catch (error) {
      logger.warn({ err: error }, 'optimize failed')
    }
  })

  const report = (): WorkerReport => ({
    at: Date.now(),
    pid: process.pid,
    startedAt,
    throttle: throttle.state(),
    queue: ctx.queue.status(),
  })

  if (config.role === 'worker') {
    let writing = false
    every(STATUS_EVERY, () => {
      if (writing) return
      writing = true
      writeStatus(config.runDir, 'worker', report())
        .catch((error: unknown) =>
          logger.warn({ err: error }, 'worker status not written'),
        )
        .finally(() => (writing = false))
    })
    // The container's health check: the process answers and its event loop
    // turns. Loopback only; nothing else needs it.
    const health = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/healthz')
        res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok')
      else res.writeHead(404).end()
    })
    health.on('error', (error) =>
      logger.error({ err: error }, 'worker health listener failed'),
    )
    health.listen(config.workerHealthPort, '127.0.0.1', () =>
      logger.info({ port: config.workerHealthPort }, 'worker listening'),
    )
    cleanups.push(() => health.close())
  }
  return { report }
}
