// A read thread of the agent API (`pool.ts`): its own read-only connection
// to the database, and media links signed as the web process signs them.
// Started by path; answers one `PoolRequest` at a time.
import { parentPort, workerData } from 'node:worker_threads'
import { BucketBlobStore } from '#blob/bucket-store.ts'
import { FsBlobStore } from '#blob/fs-store.ts'
import { MediaSigner } from '#blob/signer.ts'
import { openDatabase } from '#db/client.ts'
import { errorBody } from './errors.ts'
import { runRead } from './reads.ts'
import type { PoolRequest, PoolResponse } from './pool.ts'
import type { AgentReader, TypeCatalog } from './query.ts'

export interface ReadThreadData {
  databasePath: string
  mediaDir: string
  /** The key media links are signed with (`deriveKey(…, 'media-url')`). */
  mediaKey: Uint8Array
  /** The media bucket's public address, with R2. */
  publicUrl?: string
  types: TypeCatalog
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

if (parentPort) {
  const port = parentPort
  const reader = threadReader(workerData as ReadThreadData)
  port.on('message', async (request: PoolRequest) => {
    let response: PoolResponse
    try {
      const value = await runRead(reader, request.op, request.input)
      response = { id: request.id, ok: true, value }
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
    port.postMessage(response)
  })
  port.postMessage({ ready: true } satisfies PoolResponse)
}
