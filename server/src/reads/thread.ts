// A read thread (`pool.ts`): its own read-only connection to the database,
// and media links signed as the web process signs them. It answers the web
// app's `GET /v1` requests (`http`, through the same API as the web process,
// `#http/offload.ts`) and the agent API's reads (`#agent/reads.ts`), one at a
// time. Started by path.
import { Writable } from 'node:stream'
import { parentPort, workerData } from 'node:worker_threads'
import { Hono } from 'hono'
import { pino } from 'pino'
import { errorBody } from '#agent/errors.ts'
import { runRead } from '#agent/reads.ts'
import { BucketBlobStore } from '#blob/bucket-store.ts'
import { FsBlobStore } from '#blob/fs-store.ts'
import { KeyedLock } from '#blob/locks.ts'
import { MediaSigner } from '#blob/signer.ts'
import { forgetRecords, keepFinishedRecords } from '#capture/record-cache.ts'
import { openDatabase } from '#db/client.ts'
import { createApi, type ForwardedEnv } from '#http/app.ts'
import type { AccountsContext } from '#accounts/accounts.ts'
import type { AgentReader, TypeCatalog } from '#agent/query.ts'
import type { ForwardedRequest, ForwardedResponse } from '#http/offload.ts'
import type { Logger } from '#log.ts'
import type { PoolRequest, PoolResponse } from './pool.ts'

export interface ReadThreadData {
  databasePath: string
  mediaDir: string
  /** The key media links are signed with (`deriveKey(…, 'media-url')`). */
  mediaKey: Uint8Array
  /** The media bucket's public address, with R2. */
  publicUrl?: string
  types: TypeCatalog
  /** What the web process's API is made with (`createApi`). */
  webAppUrl?: string
  dev?: boolean
  logLevel?: string
}

/** The reader a thread works with. */
export function threadReader(data: ReadThreadData): AgentReader {
  const db = openDatabase(data.databasePath, {
    readOnly: true,
    busyTimeoutMs: 1000,
  })
  const local = new FsBlobStore(
    data.mediaDir,
    new MediaSigner({ secret: data.mediaKey }),
  )
  // Only `url` is used: confirmed uploads link to the bucket's public
  // address, the rest to this server, exactly as the web process links.
  const blobs = data.publicUrl
    ? new BucketBlobStore({
        local,
        bucket: undefined as never,
        publicUrl: data.publicUrl,
        purge: () => Promise.resolve(),
      })
    : local
  return { db, blobs, types: data.types }
}

/**
 * What a read thread lacks: using it means the route belongs on the web
 * process's thread (`inline`).
 */
function absent<T extends object>(what: string): T {
  return new Proxy({} as T, {
    get(_, key) {
      throw new Error(
        `${what} (${String(key)}) is not on a read thread; mark the route inline`,
      )
    },
  })
}

/** The context the web process's API reads with, on this thread. */
export function threadContext(
  reader: AgentReader,
  logger: Logger,
): AccountsContext {
  return {
    db: reader.db,
    blobs: reader.blobs,
    logger,
    queue: absent('the job queue'),
    platforms: absent('the platforms'),
    vault: absent('the credential vault'),
    openCredential: () => {
      throw new Error('credentials are not on a read thread')
    },
    stagingDir: '',
    mediaLocks: new KeyedLock(),
  }
}

/** Answers forwarded requests with the web process's API, by mount point. */
export function threadApi(
  ctx: AccountsContext,
  data: Pick<ReadThreadData, 'webAppUrl' | 'dev'>,
) {
  const api = createApi({
    ctx,
    webAppUrl: data.webAppUrl,
    dev: !!data.dev,
    trusted: true,
  })
  const apps = new Map<string, Hono>()
  return async (request: ForwardedRequest): Promise<ForwardedResponse> => {
    let app = apps.get(request.base)
    if (!app) {
      app = new Hono().route(request.base, api)
      apps.set(request.base, app)
    }
    const env: ForwardedEnv = {
      forwarded: {
        session: request.session,
        ...(request.token ? { token: request.token } : {}),
      },
    }
    const response = await app.fetch(
      new Request(request.url, { headers: request.headers }),
      env,
    )
    return {
      status: response.status,
      headers: [...response.headers],
      body: await response.arrayBuffer(),
    }
  }
}

if (parentPort) {
  const port = parentPort
  const data = workerData as ReadThreadData
  // Lines go to the web process, which writes them with its own.
  const logger = pino(
    { level: data.logLevel ?? 'info' },
    new Writable({
      write(chunk: { toString: () => string }, _encoding, done) {
        port.postMessage({ log: chunk.toString() } satisfies PoolResponse)
        done()
      },
    }),
  )
  const reader = threadReader(data)
  const web = threadApi(threadContext(reader, logger), data)
  keepFinishedRecords()
  port.on('message', async (request: PoolRequest) => {
    if (request.op === 'forget') {
      forgetRecords()
      return
    }
    let response: PoolResponse
    let transfer: ArrayBuffer[] = []
    try {
      if (request.op === 'http') {
        const value = await web(request.input as ForwardedRequest)
        transfer = [value.body]
        response = { id: request.id, ok: true, value }
      } else {
        const value = await runRead(reader, request.op, request.input)
        response = { id: request.id, ok: true, value }
      }
    } catch (error) {
      const body = errorBody(error)
      response = {
        id: request.id,
        ok: false,
        error: body,
        ...(body.error === 'internal' && error instanceof Error
          ? { cause: error.stack ?? error.message }
          : {}),
      }
    }
    port.postMessage(response, transfer)
  })
  port.postMessage({ ready: true } satisfies PoolResponse)
}
