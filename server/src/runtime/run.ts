import process from 'node:process'
import { loadConfig, type Config } from '#config.ts'
import { isBusy } from '#db/client.ts'
import { createLogger, type Logger } from '#log.ts'
import { sendOnlyNotifier } from '#telegram/notify.ts'
import { openRuntime, type RuntimeOverrides } from './context.ts'
import { readStatus, type WorkerReport } from './status-file.ts'
import { startWeb, type WebHandle, type WebStatus } from './web.ts'
import { startWorker, type WorkerHandle } from './worker.ts'

// What one process does depends on MIDDEN_ROLE (`#config.ts`): `web` serves
// HTTP and runs the bot, `worker` runs the jobs and timers, `all` (the
// default, for development) both. Production runs one process of each, so
// the jobs' database work never stalls a request.

// A status file older than this means its process is not running.
const WORKER_REPORT_AGE = 15_000
const WEB_STATUS_AGE = 10_000

/**
 * The server process, as main.ts starts it. The load test
 * (`scripts/bench-load.ts`) passes fakes for the platforms and stores.
 */
export async function run(
  overrides: (
    config: Config,
    logger: Logger,
  ) => RuntimeOverrides | Promise<RuntimeOverrides> = () => ({}),
): Promise<void> {
  const config = loadConfig()
  const base = createLogger(config.logLevel, config.logFile)
  const logger =
    config.role === 'all' ? base : base.child({ role: config.role })

  // Registered before anything else: in the container this process is PID 1,
  // for which a signal without a handler does nothing, so a stop during
  // startup would wait for the kill. Each step that starts something adds
  // how to end it; they run newest first.
  const cleanups: (() => unknown)[] = []
  const starting = new AbortController()
  cleanups.push(() => starting.abort())
  let stopping = false
  async function shutdown(signal: NodeJS.Signals) {
    if (stopping) return
    stopping = true
    logger.info({ signal }, 'shutting down')
    for (const cleanup of cleanups.toReversed()) {
      try {
        await cleanup()
      } catch (error) {
        logger.error({ err: error }, 'shutdown step failed')
      }
    }
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  // The last resort for a locked database that escaped a loop's own
  // handling: the lock passes, the process must stay. Anything else still
  // ends it.
  for (const event of ['uncaughtException', 'unhandledRejection'] as const)
    process.on(event, (error: unknown) => {
      if (isBusy(error)) {
        logger.error({ err: error, event }, 'database locked; continuing')
        return
      }
      logger.fatal({ err: error, event }, 'crashed')
      process.exit(1)
    })

  const rt = await openRuntime(
    config,
    logger,
    cleanups,
    await overrides(config, logger),
    starting.signal,
  )

  let worker: WorkerHandle | undefined
  let web: WebHandle | undefined
  if (config.role !== 'worker')
    web = startWeb(rt, {
      worker:
        config.role === 'all'
          ? () => worker?.report()
          : () =>
              readStatus<WorkerReport>(
                config.runDir,
                'worker',
                WORKER_REPORT_AGE,
              ),
    })
  if (config.role === 'web') return
  const notify =
    web?.notify ??
    (config.telegram
      ? sendOnlyNotifier({
          token: config.telegram.token,
          owner: config.telegram.owner,
          logger,
          // As the bot's (`web.ts`): only main.test.ts sets it.
          ...(process.env.MIDDEN_TEST_TELEGRAM_API_ROOT
            ? { client: { apiRoot: process.env.MIDDEN_TEST_TELEGRAM_API_ROOT } }
            : {}),
        })
      : () => {})
  const load = web?.load
  worker = startWorker(rt, {
    notify,
    webSignal: load
      ? () => load.signal()
      : () =>
          readStatus<WebStatus>(config.runDir, 'web', WEB_STATUS_AGE)?.signal,
  })
}
