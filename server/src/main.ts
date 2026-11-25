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
import { startBot, type RunningBot } from '#telegram/bot.ts'
import { StorageUsage } from '#usage/storage.ts'
import type { AccountsContext } from '#accounts/accounts.ts'

const MAINTENANCE_INTERVAL = 60_000
const OPTIMIZE_INTERVAL = 6 * 60 * 60_000
const APP_PREFIX = /^\/app/

const config = loadConfig()
const logger = createLogger(config.logLevel, config.logFile)
const db = openDatabase(config.databasePath)
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
// answers and a deploy rolls back.
const blobs = await openMediaStore(config, signer, logger)

let ctx!: AccountsContext
const queue = new JobQueue({
  db,
  logger,
  handlers: captureHandlers(() => ctx),
  concurrency: { capture: 4, download: 8, control: 4, upload: 4 },
  isPermanent,
})
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
  thumbnailer,
}

let bot: RunningBot | undefined
const litestream = config.litestream
  ? watchLitestream({
      db,
      host: config.host,
      logger,
      notify: (text) => bot?.notify(text),
    })
  : undefined
const storage = new StorageUsage({
  db,
  dataDir: config.dataDir,
  databasePath: config.databasePath,
  mediaDir: config.mediaDir,
  cloudflare: config.cloudflare,
  logger,
  notify: (text) => bot?.notify(text),
})
const api = createApi({
  ctx,
  telegram: config.telegram,
  webAppUrl: config.webAppUrl,
  dev: config.dev,
  litestream,
  storage,
  challengeKey: deriveKey(config.secretKey, 'passkey-challenge'),
  notify: (text) => bot?.notify(text),
})

const app = new Hono()
app.get('/healthz', (c) => c.text('ok'))
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

queue.start()
if (config.telegram)
  bot = await startBot({
    ctx,
    token: config.telegram.token,
    owner: config.telegram.owner,
    webAppUrl: config.webAppUrl,
    version: process.env.BUILD_REVISION || 'dev',
    ffmpeg: config.ffmpeg,
  })
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
const server = serve(
  { fetch: app.fetch, port: config.port, hostname: config.host },
  (info) =>
    logger.info({ address: info.address, port: info.port }, 'listening'),
)

let stopping = false
async function shutdown(signal: NodeJS.Signals) {
  if (stopping) return
  stopping = true
  logger.info({ signal }, 'shutting down')
  clearInterval(maintenance)
  clearInterval(optimizing)
  litestream?.close()
  server.close()
  await bot?.stop()
  await queue.stop()
  db.$client.close()
  process.exit(0)
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
