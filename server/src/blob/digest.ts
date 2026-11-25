import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import type { Readable } from 'node:stream'

export interface Digest {
  size: number
  /** Hex: the blob key of these bytes. */
  sha256: string
  /** Hex: what S3 reports as the ETag of an object stored in one part. */
  md5: string
}

/** Size, SHA-256 and MD5 of a stream, read once. */
export async function digestStream(
  stream: Readable | AsyncIterable<Uint8Array>,
): Promise<Digest> {
  const sha256 = createHash('sha256')
  const md5 = createHash('md5')
  let size = 0
  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    size += chunk.length
    sha256.update(chunk)
    md5.update(chunk)
  }
  return { size, sha256: sha256.digest('hex'), md5: md5.digest('hex') }
}

export function digestFile(file: string): Promise<Digest> {
  return digestStream(createReadStream(file))
}
