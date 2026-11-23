import process from 'node:process'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { FsBlobStore } from '#blob/fs-store.ts'
import { mediaRoutes } from '#blob/route.ts'
import { MediaSigner } from '#blob/signer.ts'
import { loadConfig } from '#config.ts'
import { deriveKey } from '#crypto.ts'
import { openDatabase } from '#db/client.ts'
import { JobQueue } from '#jobs/queue.ts'
import { createLogger } from '#log.ts'

const config = loadConfig()
const logger = createLogger(config.logLevel)
const db = openDatabase(config.databasePath)
const signer = new MediaSigner({
  secret: deriveKey(config.secretKey, 'media-url'),
})
const blobs = new FsBlobStore(config.mediaDir, signer)
const queue = new JobQueue({
  db,
  logger,
  handlers: {},
  concurrency: { capture: 4, download: 8, control: 4 },
})

const app = new Hono()
app.get('/healthz', (c) => c.text('ok'))
app.route('/', mediaRoutes(blobs, signer))

queue.start()
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
  server.close()
  await queue.stop()
  db.$client.close()
  process.exit(0)
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
