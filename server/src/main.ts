import path from 'node:path'
import process from 'node:process'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { Vault } from '#accounts/vault.ts'
import { KeyedLock } from '#blob/locks.ts'
import { openMediaStore } from '#blob/open.ts'
import { mediaRoutes } from '#blob/route.ts'
import { MediaSigner } from '#blob/signer.ts'
import { isPermanent } from '#capture/errors.ts'
import { captureHandlers } from '#capture/handlers.ts'
import { runMaintenance } from '#capture/maintenance.ts'
import { detectThumbnailer, regenerateThumbnail } from '#capture/thumbnail.ts'
import { loadConfig } from '#config.ts'
import { deriveKey } from '#crypto.ts'
import { openDatabase, optimize } from '#db/client.ts'
import { createApi } from '#http/app.ts'
import { pruneSessions } from '#http/auth.ts'
import { prunePasskeys } from '#http/passkeys.ts'
import { JobQueue } from '#jobs/queue.ts'
import { catalogMissing } from '#library/catalog.ts'
import { watchLitestream } from '#litestream.ts'
import { createLogger } from '#log.ts'
import { createInstagramPlatform } from '#platforms/instagram/index.ts'
import { Platforms } from '#platforms/registry.ts'
import { createXPlatform } from '#platforms/x/index.ts'
import { openRawStore } from '#raw/store.ts'
import { launchBot, type BotHandle } from '#telegram/launch.ts'
import { StorageUsage } from '#usage/storage.ts'
import type { AccountsContext } from '#accounts/accounts.ts'

const MAINTENANCE_INTERVAL = 60_000
const OPTIMIZE_INTERVAL = 6 * 60 * 60_000
const APP_PREFIX = /^\/app/

const config = loadConfig()
const logger = createLogger(config.logLevel, config.logFile)

// Registered before anything else: in the container this process is PID 1,
// for which a signal without a handler does nothing, so a stop during
// startup would wait for the kill. Each step that starts something adds
// how to end it; they run newest first.
const cleanups: (() => unknown)[] = []
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

const db = openDatabase(config.databasePath)
cleanups.push(() => db.$client.close())
const catalogued = catalogMissing(db)
if (catalogued) logger.info({ count: catalogued }, 'catalogued collections')
const signer = new MediaSigner({
  secret: deriveKey(config.secretKey, 'media-url'),
})
const vault = new Vault(deriveKey(config.secretKey, 'credentials'))
const thumbnailer = await detectThumbnailer(config.ffmpeg)
if (!thumbnailer) logger.warn('ffmpeg not found; thumbnails are disabled')
logger.info({ store: config.media.store }, 'media store')
// Before anything listens: without working R2 credentials this throws and
// the process exits, as with any invalid configuration, so /healthz never
// answers and a deploy rolls back. The token check has short timeouts, so a
// stalled network fails it well within the deploy's wait.
const blobs = await openMediaStore(config, signer, logger)
const raw = await openRawStore(config, logger)
logger.info({ store: raw ? 'r2' : 'database' }, 'raw responses store')

let ctx!: AccountsContext
const queue = new JobQueue({
  db,
  logger,
  handlers: captureHandlers(() => ctx),
  concurrency: { capture: 4, download: 8, control: 4, upload: 4, raw: 4 },
  isPermanent,
})
cleanups.push(() => queue.stop())
ctx = {
  db,
  queue,
  logger,
  platforms: new Platforms([createXPlatform(), createInstagramPlatform()]),
  blobs,
  stagingDir: path.join(config.dataDir, 'tmp'),
  vault,
  openCredential: (ref) => vault.open(db, ref),
  mediaLocks: new KeyedLock(),
  ...(raw ? { raw } : {}),
  thumbnailer,
}

// Started after the server listens; until it runs, notices wait in it.
let bot: BotHandle | undefined
const notify = (text: string) => bot?.notify(text)
const litestream = config.litestream
  ? watchLitestream({ db, host: config.host, logger, notify })
  : undefined
if (litestream) cleanups.push(() => litestream.close())
const storage = new StorageUsage({
  db,
  dataDir: config.dataDir,
  databasePath: config.databasePath,
  mediaDir: config.mediaDir,
  cloudflare: config.cloudflare,
  logger,
  notify,
})
const api = createApi({
  ctx,
  telegram: config.telegram,
  webAppUrl: config.webAppUrl,
  dev: config.dev,
  litestream,
  storage,
  challengeKey: deriveKey(config.secretKey, 'passkey-challenge'),
  notify,
  ...(config.telegram ? { botState: () => bot?.state() ?? 'starting' } : {}),
})

const app = new Hono()
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
// With R2, this serves thumbnails (a local cache, rendered again when lost),
// downloads, and originals until their upload is confirmed.
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
queue.start()

// In the background: Telegram being slow or down must not keep the server
// from serving. Deliveries wait in the database until the bot runs.
if (config.telegram) {
  const handle = launchBot({
    ctx,
    token: config.telegram.token,
    owner: config.telegram.owner,
    webAppUrl: config.webAppUrl,
    version: process.env.BUILD_REVISION || 'dev',
    ffmpeg: config.ffmpeg,
    ...(config.telegram.apiRoot
      ? { client: { apiRoot: config.telegram.apiRoot } }
      : {}),
  })
  bot = handle
  cleanups.push(() => handle.stop())
}

let maintaining = false
const maintenance = setInterval(() => {
  if (maintaining) return
  maintaining = true
  pruneSessions(db)
  prunePasskeys(db)
  runMaintenance(ctx)
    .catch(() => {})
    .finally(() => (maintaining = false))
  // Paced by itself: every 15 minutes, and the composition once a day.
  storage
    .tick()
    .catch((error: unknown) =>
      logger.error({ err: error }, 'storage usage failed'),
    )
}, MAINTENANCE_INTERVAL)
const optimizing = setInterval(optimize, OPTIMIZE_INTERVAL, db)
cleanups.push(() => {
  clearInterval(maintenance)
  clearInterval(optimizing)
})
