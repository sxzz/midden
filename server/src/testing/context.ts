import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pino } from 'pino'
import { FsBlobStore } from '#blob/fs-store.ts'
import { MediaSigner } from '#blob/signer.ts'
import { isPermanent } from '#capture/errors.ts'
import { openDatabase } from '#db/client.ts'
import { JobQueue, type JobHandler } from '#jobs/queue.ts'
import { createInstagramPlatform } from '#platforms/instagram/index.ts'
import { Platforms } from '#platforms/registry.ts'
import { createXPlatform } from '#platforms/x/index.ts'
import type { CaptureContext } from '#capture/context.ts'
import type { Platform } from '#platforms/platform.ts'

/** A capture context on a fresh in-memory database and temp media dir. */
export function testContext(
  options: {
    platforms?: Platform[]
    handlers?: (ctx: () => CaptureContext) => Record<string, JobHandler>
    now?: () => number
  } = {},
): CaptureContext {
  const db = openDatabase(':memory:')
  const logger = pino({ level: 'silent' })
  const dir = mkdtempSync(path.join(tmpdir(), 'midden-test-'))
  const signer = new MediaSigner({ secret: new TextEncoder().encode('test') })
  const noop: JobHandler = { queue: 'control', run: async () => {} }
  let ctx: CaptureContext | undefined
  const handlers = {
    capture: { ...noop, queue: 'capture' },
    download: { ...noop, queue: 'download' },
    thumbnail: { ...noop, queue: 'download', priority: 4 },
    finalize: noop,
    related: noop,
    refresh_batch: noop,
    ...options.handlers?.(() => ctx!),
  }
  const queue = new JobQueue({
    db,
    logger,
    handlers,
    concurrency: { capture: 4, download: 8, control: 4 },
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
    blobs: new FsBlobStore(path.join(dir, 'media'), signer),
    stagingDir: path.join(dir, 'tmp'),
    openCredential: () => {
      throw new Error('no credentials in tests')
    },
    now: options.now,
  }
  return ctx
}
