import path from 'node:path'
import process from 'node:process'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { Vault } from '#accounts/vault.ts'
import { FsBlobStore } from '#blob/fs-store.ts'
import { KeyedLock } from '#blob/locks.ts'
import { mediaRoutes } from '#blob/route.ts'
import { MediaSigner } from '#blob/signer.ts'
import { isPermanent } from '#capture/errors.ts'
import { captureHandlers } from '#capture/handlers.ts'
import { runMaintenance } from '#capture/maintenance.ts'
import { detectThumbnailer } from '#capture/thumbnail.ts'
import { loadConfig } from '#config.ts'
import { deriveKey } from '#crypto.ts'
import { openDatabase } from '#db/client.ts'
import { JobQueue } from '#jobs/queue.ts'
import { createLogger } from '#log.ts'
import { createInstagramPlatform } from '#platforms/instagram/index.ts'
import { Platforms } from '#platforms/registry.ts'
import { createXPlatform } from '#platforms/x/index.ts'
import type { AccountsContext } from '#accounts/accounts.ts'

const MAINTENANCE_INTERVAL = 60_000

const config = loadConfig()
const logger = createLogger(config.logLevel)
const db = openDatabase(config.databasePath)
const signer = new MediaSigner({
  secret: deriveKey(config.secretKey, 'media-url'),
})
const vault = new Vault(deriveKey(config.secretKey, 'credentials'))
const thumbnailer = await detectThumbnailer(config.ffmpeg)
if (!thumbnailer) logger.warn('ffmpeg not found; thumbnails are disabled')

let ctx!: AccountsContext
const queue = new JobQueue({
  db,
  logger,
  handlers: captureHandlers(() => ctx),
  concurrency: { capture: 4, download: 8, control: 4 },
  isPermanent,
})
ctx = {
  db,
  queue,
  logger,
  platforms: new Platforms([createXPlatform(), createInstagramPlatform()]),
  blobs: new FsBlobStore(config.mediaDir, signer),
  stagingDir: path.join(config.dataDir, 'tmp'),
  vault,
  openCredential: (ref) => vault.open(db, ref),
  mediaLocks: new KeyedLock(),
  thumbnailer,
}

const app = new Hono()
app.get('/healthz', (c) => c.text('ok'))
app.route('/', mediaRoutes(ctx.blobs, signer))

queue.start()
let maintaining = false
const maintenance = setInterval(() => {
  if (maintaining) return
  maintaining = true
  runMaintenance(ctx)
    .catch(() => {})
    .finally(() => (maintaining = false))
}, MAINTENANCE_INTERVAL)

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
  server.close()
  await queue.stop()
  db.$client.close()
  process.exit(0)
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
