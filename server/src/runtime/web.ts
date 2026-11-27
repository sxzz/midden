import process from 'node:process'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { createAgentApi } from '#agent/app.ts'
import { agentDocRoutes } from '#agent/doc.ts'
import { pooledReads, typeCatalog } from '#agent/runner.ts'
import { mediaRoutes } from '#blob/route.ts'
import { regenerateThumbnail } from '#capture/thumbnail.ts'
import { deriveKey } from '#crypto.ts'
import { createApi } from '#http/app.ts'
import { WebLoad } from '#http/load.ts'
import { pooledWebReads } from '#http/offload.ts'
import { watchLitestream } from '#litestream.ts'
import { QueryPool, READ_THREAD } from '#reads/pool.ts'
import { SlowQueryLog } from '#reads/slow-log.ts'
import { launchBot, type BotHandle } from '#telegram/launch.ts'
import { TokenUsage } from '#tokens/usage.ts'
import { StorageUsage } from '#usage/storage.ts'
import { WEB_BUSY_TIMEOUT, type Runtime } from './context.ts'
import { writeStatus, type Stamped, type WorkerReport } from './status-file.ts'
import type { WebLoadSignal } from '#jobs/throttle.ts'
import type { ReadThreadData } from '#reads/thread.ts'

/** The web process's status file: its recent load, for the throttle. */
export interface WebStatus extends Stamped {
  signal: WebLoadSignal
}

export interface WebOptions {
  /** The worker's report: in this process, or from its status file. */
  worker: () => WorkerReport | undefined
}

export interface WebHandle {
  /** A short message to the owner through the bot. */
  notify: (text: string) => void
  load: WebLoad
}

const APP_PREFIX = /^\/app/
const STATUS_EVERY = 2000

/**
 * The web process: HTTP (the API, media, the web app), the Telegram bot and
 * the Litestream heartbeat. It enqueues jobs but runs none.
 */
export function startWeb(rt: Runtime, options: WebOptions): WebHandle {
  const { config, logger, db, ctx, signer, cleanups } = rt

  const load = new WebLoad({ logger })
  load.start()
  cleanups.push(() => load.stop())

  // Started after the server listens; until it runs, notices wait in it.
  let bot: BotHandle | undefined
  const notify = (text: string) => bot?.notify(text)
  const litestream = config.litestream
    ? watchLitestream({ db, host: config.host, logger, notify })
    : undefined
  if (litestream) cleanups.push(() => litestream.close())
  // The page's figures; the worker records them (its `tick`).
  const storage = new StorageUsage({
    db,
    dataDir: config.dataDir,
    databasePath: config.databasePath,
    mediaDir: config.mediaDir,
    cloudflare: config.cloudflare,
    logger,
    notify,
  })
  // Requests per API token, written about once a minute.
  const tokenUsage = new TokenUsage({ db, logger })
  tokenUsage.start()
  cleanups.push(() => tokenUsage.stop())
  // Reads run on threads with connections of their own (`reads/pool.ts`):
  // the web app's `GET /v1` requests and the agent API's reads.
  const types = typeCatalog(ctx.platforms)
  // Their slow statements: logged, and the last few hundred kept.
  const slowQueries = new SlowQueryLog({
    db,
    logger,
    busyTimeoutMs: WEB_BUSY_TIMEOUT,
  })
  cleanups.push(() => slowQueries.stop())
  const pool = new QueryPool({
    script: READ_THREAD,
    workerData: {
      databasePath: config.databasePath,
      mediaDir: config.mediaDir,
      mediaKey: deriveKey(config.secretKey, 'media-url'),
      ...(config.media.store === 'r2'
        ? { publicUrl: config.media.r2.publicUrl }
        : {}),
      types,
      countPointers: ctx.platforms.countPointers(),
      webAppUrl: config.webAppUrl,
      dev: config.dev,
      logLevel: logger.level,
    } satisfies ReadThreadData,
    logger,
    onSlow: (query) => slowQueries.record(query),
  })
  cleanups.push(() => pool.close())
  // The web app's first requests need not wait for threads to start.
  pool.warm(2)
  // Finished capture records the threads keep between polls may be out of
  // date after a write (`capture/record-cache.ts`).
  const forget = () => pool.broadcast('forget')
  const api = createApi({
    ctx,
    telegram: config.telegram,
    webAppUrl: config.webAppUrl,
    dev: config.dev,
    litestream,
    storage,
    queue: { worker: options.worker, web: () => load.report() },
    challengeKey: deriveKey(config.secretKey, 'passkey-challenge'),
    notify,
    tokenUsage,
    reads: pooledWebReads(pool),
    onWrite: forget,
    ...(config.telegram ? { botState: () => bot?.state() ?? 'starting' } : {}),
  })
  const agent = createAgentApi({
    ctx,
    reads: pooledReads(pool),
    reader: { db, blobs: ctx.blobs, types },
    usage: tokenUsage,
    onWrite: forget,
  })

  const app = new Hono()
  app.use(load.middleware())
  // The process serves and its database answers; Telegram is not part of it.
  app.get('/healthz', (c) => {
    try {
      db.$client.prepare('SELECT 1').get()
    } catch {
      return c.text('database unavailable', 503)
    }
    return c.text('ok')
  })
  app.route('/v1', api)
  // For AI agents and scripts; its guide is public.
  app.route('/', agent)
  app.route('/', agentDocRoutes())
  // With R2, this serves thumbnails (a local cache, fetched again when
  // lost), downloads, and originals until their upload is confirmed.
  app.route(
    '/',
    mediaRoutes(
      ctx.blobs,
      signer,
      config.media.store === 'r2'
        ? {
            sharedCache: true,
            regenerate: (key) => regenerateThumbnail(ctx, key),
          }
        : {},
    ),
  )
  // The built web app; unknown paths under /app/ load the app itself. Public
  // links open inside it, and neither it nor they belong in search results.
  app.use('/app/*', async (c, next) => {
    await next()
    c.header('X-Robots-Tag', 'noindex, nofollow')
  })
  app.use(
    '/app/*',
    serveStatic({
      root: config.webDir,
      rewriteRequestPath: (path) => path.replace(APP_PREFIX, ''),
    }),
  )
  app.get('/app/*', serveStatic({ root: config.webDir, path: 'index.html' }))
  app.get('/', (c) => c.redirect('/app/'))

  const server = serve(
    { fetch: app.fetch, port: config.port, hostname: config.host },
    (info) =>
      logger.info({ address: info.address, port: info.port }, 'listening'),
  )
  cleanups.push(() => server.close())

  if (config.role === 'web') {
    let writing = false
    const timer = setInterval(() => {
      if (writing) return
      writing = true
      const status: WebStatus = { at: Date.now(), signal: load.signal() }
      writeStatus(config.runDir, 'web', status)
        .catch((error: unknown) =>
          logger.warn({ err: error }, 'web status not written'),
        )
        .finally(() => (writing = false))
    }, STATUS_EVERY)
    cleanups.push(() => clearInterval(timer))
  }

  // In the background: Telegram being slow or down must not keep the server
  // from serving. Deliveries wait in the database until the bot runs.
  if (config.telegram) {
    const handle = launchBot({
      ctx,
      token: config.telegram.token,
      owner: config.telegram.owner,
      webAppUrl: config.webAppUrl,
      version: process.env.BUILD_REVISION || 'dev',
      onWrite: forget,
      // Only main.test.ts sets this, to point the bot at a fake Telegram.
      ...(process.env.MIDDEN_TEST_TELEGRAM_API_ROOT
        ? { client: { apiRoot: process.env.MIDDEN_TEST_TELEGRAM_API_ROOT } }
        : {}),
    })
    bot = handle
    cleanups.push(() => handle.stop())
  }
  return { notify, load }
}
