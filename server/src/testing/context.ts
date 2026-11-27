import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pino } from 'pino'
import { Vault } from '#accounts/vault.ts'
import { FsBlobStore } from '#blob/fs-store.ts'
import { KeyedLock } from '#blob/locks.ts'
import { MediaSigner } from '#blob/signer.ts'
import { isPermanent } from '#capture/errors.ts'
import { openDatabase } from '#db/client.ts'
import { JobQueue, type JobHandler } from '#jobs/queue.ts'
import { createInstagramPlatform } from '#platforms/instagram/index.ts'
import { Platforms } from '#platforms/registry.ts'
import { createXPlatform } from '#platforms/x/index.ts'
import type { AccountsContext } from '#accounts/accounts.ts'
import type { CaptureContext } from '#capture/context.ts'
import type { Logger } from '#log.ts'
import type { Platform } from '#platforms/platform.ts'

/** A capture context on a fresh in-memory database and temp media dir. */
export function testContext(
  options: {
    platforms?: Platform[]
    handlers?: (ctx: () => CaptureContext) => Record<string, JobHandler>
    now?: () => number
    fetch?: typeof fetch
    logger?: Logger
    timelineCap?: number
    /** A database file to open instead, for read threads to read too. */
    file?: string
    /** The raw response bucket. */
    raw?: CaptureContext['raw']
    /** Another media store over the same directory and signer. */
    blobs?: (media: {
      dir: string
      signer: MediaSigner
      logger: Logger
    }) => CaptureContext['blobs']
  } = {},
): AccountsContext {
  const db = openDatabase(options.file ?? ':memory:')
  const vault = new Vault(new Uint8Array(32).fill(7))
  const logger = options.logger ?? pino({ level: 'silent' })
  const dir = mkdtempSync(path.join(tmpdir(), 'midden-test-'))
  const signer = new MediaSigner({ secret: new TextEncoder().encode('test') })
  const noop: JobHandler = { queue: 'control', run: async () => {} }
  let ctx: AccountsContext | undefined
  const handlers = {
    capture: { ...noop, queue: 'capture' },
    download: { ...noop, queue: 'download' },
    upload: { ...noop, queue: 'upload' },
    'raw-upload': { ...noop, queue: 'raw' },
    finalize: noop,
    related: noop,
    relations: { ...noop, queue: 'capture' },
    update: noop,
    'video-removal': noop,
    ...options.handlers?.(() => ctx!),
  }
  const queue = new JobQueue({
    db,
    logger,
    handlers,
    concurrency: { capture: 4, download: 8, control: 4, upload: 4, raw: 4 },
    now: options.now,
    isPermanent,
  })
  ctx = {
    db,
    queue,
    logger,
    platforms: new Platforms(
      options.platforms ?? [createXPlatform(), createInstagramPlatform()],
    ),
    blobs:
      options.blobs?.({ dir: path.join(dir, 'media'), signer, logger }) ??
      new FsBlobStore(path.join(dir, 'media'), signer),
    vault,
    openCredential: (ref) => vault.open(db, ref),
    now: options.now,
    mediaLocks: new KeyedLock(),
    raw: options.raw,
    fetch: options.fetch,
    timelineCap: options.timelineCap,
  }
  return ctx
}
