import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** How much of the start of a file is kept in memory as `head`. */
export const HEAD_BYTES = 64 * 1024

export interface StagedFile {
  path: string
  /** SHA-256, lowercase hex: the blob key. */
  hash: string
  size: number
  /** The first `HEAD_BYTES` (fewer for a smaller file). */
  head: Buffer
  discard: () => Promise<void>
}

export class TooLargeError extends Error {
  override name = 'TooLargeError'
}

/**
 * Write a stream to a temporary file while hashing it. The staging directory
 * sits beside the media directory, so the fs store can publish by rename.
 */
export async function stage(
  dir: string,
  body: Readable | AsyncIterable<Uint8Array>,
  options: { maxBytes?: number; signal?: AbortSignal } = {},
): Promise<StagedFile> {
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, `${randomUUID()}.part`)
  const hash = createHash('sha256')
  const head: Buffer[] = []
  let headBytes = 0
  let size = 0
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length
      if (options.maxBytes !== undefined && size > options.maxBytes) {
        callback(new TooLargeError(`exceeds ${options.maxBytes} bytes`))
        return
      }
      hash.update(chunk)
      if (headBytes < HEAD_BYTES) {
        const part = chunk.subarray(0, HEAD_BYTES - headBytes)
        head.push(Buffer.from(part))
        headBytes += part.length
      }
      callback(null, chunk)
    },
  })
  try {
    await pipeline(body, meter, createWriteStream(file, { flush: true }), {
      signal: options.signal,
    })
  } catch (error) {
    await rm(file, { force: true })
    throw error
  }
  return {
    path: file,
    hash: hash.digest('hex'),
    size,
    head: Buffer.concat(head),
    discard: () => rm(file, { force: true }),
  }
}
