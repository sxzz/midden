import { createServer } from 'node:http'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { FOLDED_KEY, settleHandleProfiles } from '#capture/identify.ts'
import { runMaintenance } from '#capture/maintenance.ts'
import { checkProgress } from '#capture/progress-check.ts'
import { adoptUpdates, settleProgress } from '#capture/progress.ts'
import { refreshSummaries } from '#capture/summary-sweep.ts'
import { runWatches } from '#capture/watches.ts'
import { optimize, unknownMigrations } from '#db/client.ts'
import { prunePasskeys } from '#http/passkeys.ts'
import { pruneSessions } from '#http/sessions.ts'
import { currentJob, RANK, withOrigin } from '#jobs/queue.ts'
import { FolderCountSweep } from '#library/folder-counts.ts'
import { readSetting, writeSetting } from '#settings.ts'
import { StorageUsage } from '#usage/storage.ts'
import { pruneInvites } from '#users/invites.ts'
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
const WATCH_INTERVAL = 60_000
const COMPOSITION_POLL = 5000
// Finished capture records are counted and written down (`summary-sweep.ts`).
const SUMMARY_INTERVAL = 10_000
// Folders are counted in the background (`library/folder-counts.ts`): new
// and edited ones within this, the rest as the sweep's debounce allows.
const FOLDER_POLL = 2000
// Updates' progress is kept as members change (`progress.ts`), and some of
// it checked against a full count now and then.
const PROGRESS_INTERVAL = 1000
const PROGRESS_CHECK_INTERVAL = 60_000
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
          // Slowing down: what halved it; speeding up: what still shows.
          reason: state.factor < factor ? state.cause?.reason : state.reason,
        },
        state.factor < factor ? 'worker slowing down' : 'worker speeding up',
      )
    factor = state.factor
  })

  // Once: profiles saved by handle whose account the library knows move to
  // it before any job runs (a capture of one would only fail); maintenance
  // looks up the rest while idle. Later handles never make a collection.
  const settling = readSetting(db, FOLDED_KEY)
    ? Promise.resolve()
    : settleHandleProfiles(ctx).then(
        (settled) => {
          writeSetting(db, FOLDED_KEY, new Date().toISOString())
          logger.info(settled, 'profiles saved by handle settled')
        },
        (error: unknown) =>
          logger.error(
            { err: error },
            'settling profiles saved by handle failed',
          ),
      )
  settling.finally(() => ctx.queue.start())

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
    // The composition reads every page in one read transaction, which
    // holds the WAL back meanwhile: only while the worker is idle.
    composeWhen: () => ctx.queue.status().idle,
  })
  let maintaining = false
  every(MAINTENANCE_INTERVAL, () => {
    if (maintaining) return
    maintaining = true
    // Jobs maintenance enqueues (raw uploads it sweeps) come last.
    withOrigin({ rank: RANK.maintenance, updateId: null }, () => {
      try {
        pruneSessions(db)
        prunePasskeys(db)
        pruneInvites(db)
      } catch (error) {
        logger.error({ err: error }, 'pruning sessions failed')
      }
      runMaintenance(ctx, { slim: ctx.queue.status().idle })
        .catch(() => {})
        .finally(() => (maintaining = false))
    })
    // Paced by itself: every 15 minutes, and the composition once a day or
    // after a change.
    storage
      .tick()
      .catch((error: unknown) =>
        logger.error({ err: error }, 'storage usage failed'),
      )
  })
  // A reading the page asked for starts within seconds, not at the minute.
  every(COMPOSITION_POLL, () => {
    try {
      storage.poll()
    } catch (error) {
      logger.warn({ err: error }, 'composition request check failed')
    }
  })
  const folderCounts = new FolderCountSweep(db, {
    types: ctx.platforms.types(),
  })
  let counting = false
  every(FOLDER_POLL, () => {
    if (counting || ctx.queue.status().held) return
    counting = true
    folderCounts
      .run({ busy: !ctx.queue.status().idle })
      .catch((error: unknown) =>
        logger.warn({ err: error }, 'counting folders failed'),
      )
      .finally(() => (counting = false))
  })
  every(PROGRESS_INTERVAL, () => {
    if (ctx.queue.status().held) return
    try {
      settleProgress(db)
      // Updates from before it was kept wait for the worker to be idle.
      adoptUpdates(db, 2, !ctx.queue.status().idle)
    } catch (error) {
      logger.warn({ err: error }, 'keeping the progress of updates failed')
    }
  })
  every(PROGRESS_CHECK_INTERVAL, () => {
    if (ctx.queue.status().held) return
    try {
      checkProgress(ctx)
    } catch (error) {
      logger.warn({ err: error }, 'checking the progress of updates failed')
    }
  })
  every(SUMMARY_INTERVAL, () => {
    if (ctx.queue.status().held) return
    try {
      refreshSummaries(ctx)
    } catch (error) {
      logger.warn({ err: error }, 'writing down finished records failed')
    }
  })
  // 定期更新: start the runs of watches that are due. Not while held: a
  // newer version owns the database.
  every(WATCH_INTERVAL, () => {
    if (ctx.queue.status().held) return
    try {
      withOrigin({ rank: RANK.watch, updateId: null }, () => runWatches(ctx))
    } catch (error) {
      logger.error({ err: error }, 'starting watch runs failed')
    }
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
