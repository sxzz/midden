import path from 'node:path'
import { Vault } from '#accounts/vault.ts'
import { KeyedLock } from '#blob/locks.ts'
import { openMediaStore } from '#blob/open.ts'
import { MediaSigner } from '#blob/signer.ts'
import { isPermanent } from '#capture/errors.ts'
import { captureHandlers } from '#capture/handlers.ts'
import { deriveKey } from '#crypto.ts'
import { openDatabase, waitForMigrations, type Database } from '#db/client.ts'
import { JobQueue } from '#jobs/queue.ts'
import { Throttle } from '#jobs/throttle.ts'
import { catalogMissing } from '#library/catalog.ts'
import { createInstagramPlatform } from '#platforms/instagram/index.ts'
import { Platforms } from '#platforms/registry.ts'
import { createXPlatform } from '#platforms/x/index.ts'
import { openRawStore, type RawStore } from '#raw/store.ts'
import type { AccountsContext } from '#accounts/accounts.ts'
import type { BlobStore } from '#blob/store.ts'
import type { Config } from '#config.ts'
import type { Logger } from '#log.ts'

/** What both processes share: the database, the stores, the job queue. */
export interface Runtime {
  config: Config
  logger: Logger
  db: Database
  ctx: AccountsContext
  signer: MediaSigner
  /** The worker's; absent in the web process, which runs no jobs. */
  throttle?: Throttle
  /** How to end what was started, newest last; main.ts runs them. */
  cleanups: (() => unknown)[]
}

/** Tests and the load test (`scripts/bench-load.ts`) swap these. */
export interface RuntimeOverrides {
  platforms?: Platforms
  blobs?: BlobStore
  raw?: RawStore
  /** For media downloads. */
  fetch?: typeof fetch
}

export const CONCURRENCY = {
  capture: 4,
  download: 8,
  control: 4,
  upload: 4,
  raw: 4,
}
/** The worker looks for jobs the web process enqueued this often. */
const WORKER_POLL = 250
// The web process stays snappy: a write waits at most this long for the
// lock. The worker can wait; its jobs only take longer.
const WEB_BUSY_TIMEOUT = 2000
const WORKER_BUSY_TIMEOUT = 10_000

export async function openRuntime(
  config: Config,
  logger: Logger,
  cleanups: (() => unknown)[],
  overrides: RuntimeOverrides = {},
  signal?: AbortSignal,
): Promise<Runtime> {
  const { role } = config
  const worker = role === 'worker'
  const db = openDatabase(config.databasePath, {
    busyTimeoutMs: role === 'web' ? WEB_BUSY_TIMEOUT : WORKER_BUSY_TIMEOUT,
    // The web process migrates; the worker waits for it.
    migrate: !worker,
    autoCheckpoint: role !== 'web',
  })
  cleanups.push(() => db.$client.close())
  if (worker)
    await waitForMigrations(db, {
      signal,
      onWait: (pending) =>
        logger.info({ pending }, 'waiting for the web process to migrate'),
    })
  else {
    const catalogued = catalogMissing(db)
    if (catalogued) logger.info({ count: catalogued }, 'catalogued collections')
  }
  const signer = new MediaSigner({
    secret: deriveKey(config.secretKey, 'media-url'),
  })
  const vault = new Vault(deriveKey(config.secretKey, 'credentials'))
  logger.info({ store: config.media.store }, 'media store')
  // Before anything listens: without working R2 credentials this throws and
  // the process exits, as with any invalid configuration, so /healthz never
  // answers and a deploy rolls back. The token check has short timeouts, so
  // a stalled network fails it well within the deploy's wait.
  const blobs =
    overrides.blobs ?? (await openMediaStore(config, signer, logger))
  const raw = overrides.raw ?? (await openRawStore(config, logger))
  logger.info({ store: raw ? 'r2' : 'database' }, 'raw responses store')

  const throttle = role === 'web' ? undefined : new Throttle()
  let ctx!: AccountsContext
  const queue = new JobQueue({
    db,
    logger,
    handlers: captureHandlers(() => ctx),
    concurrency: CONCURRENCY,
    // Moving raw responses out of the database waits for a quiet worker.
    idleQueues: ['raw'],
    throttle,
    ...(worker ? { pollMs: WORKER_POLL } : {}),
    isPermanent,
  })
  cleanups.push(() => queue.stop())
  ctx = {
    db,
    queue,
    logger,
    platforms:
      overrides.platforms ??
      new Platforms([createXPlatform(), createInstagramPlatform()]),
    blobs,
    stagingDir: path.join(config.dataDir, 'tmp'),
    vault,
    openCredential: (ref) => vault.open(db, ref),
    mediaLocks: new KeyedLock(),
    ...(raw ? { raw } : {}),
    ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
  }
  return { config, logger, db, ctx, signer, throttle, cleanups }
}
