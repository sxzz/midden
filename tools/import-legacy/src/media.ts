import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { AwsClient } from 'aws4fetch'
import { FsBlobStore } from '../../../server/src/blob/fs-store.ts'
import { MediaSigner } from '../../../server/src/blob/signer.ts'
import type { Buffer } from 'node:buffer'

/**
 * Where the old service kept media: `objects/<uuid>` keys in one bucket, or
 * `<tenant>/objects/<uuid>` for objects written before keys dropped the tenant.
 */
export interface ObjectSource {
  readonly description: string
  /** The object's bytes, or undefined when it does not exist. */
  open: (key: string) => Promise<Readable | undefined>
}

const TRAILING_SLASHES = /\/+$/
const OBJECT_KEY =
  /^(?:[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\/)?objects\/[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/

function checkKey(key: string): void {
  if (!OBJECT_KEY.test(key)) throw new Error(`unexpected object key: ${key}`)
}

/** A local copy of the bucket, such as `s3/<bucket>` in a backup archive. */
export function directorySource(root: string): ObjectSource {
  return {
    description: root,
    open(key) {
      checkKey(key)
      const stream = createReadStream(path.join(root, key))
      return new Promise((resolve, reject) => {
        stream.once('open', () => resolve(stream))
        stream.once('error', (error: NodeJS.ErrnoException) =>
          error.code === 'ENOENT' ? resolve(undefined) : reject(error),
        )
      })
    },
  }
}

export interface S3Options {
  endpoint: string
  bucket: string
  accessKey: string
  secretKey: string
  region?: string
}

/** The bucket itself, read with path-style requests (as SeaweedFS expects). */
export function s3Source(options: S3Options): ObjectSource {
  const client = new AwsClient({
    accessKeyId: options.accessKey,
    secretAccessKey: options.secretKey,
    service: 's3',
    region: options.region ?? 'us-east-1',
  })
  const base = `${options.endpoint.replace(TRAILING_SLASHES, '')}/${encodeURIComponent(options.bucket)}`
  return {
    description: base,
    async open(key) {
      checkKey(key)
      const response = await client.fetch(`${base}/${key}`)
      if (response.status === 404) return
      if (!response.ok || !response.body)
        throw new Error(`GET ${key}: HTTP ${response.status}`)
      return Readable.fromWeb(response.body)
    },
  }
}

export interface BlobToCopy {
  id: string
  hash: string
  size: number
  objectKey: string
}

export interface MediaReport {
  total: number
  copied: number
  bytes: number
  missing: BlobToCopy[]
  mismatched: { blob: BlobToCopy; hash: string; size: number }[]
}

/**
 * Copy every blob into the new media store under its content hash, hashing
 * the bytes on the way and comparing them with what the database recorded.
 */
export async function copyMedia(
  source: ObjectSource,
  blobs: BlobToCopy[],
  mediaDir: string,
  options: { concurrency?: number; onProgress?: (done: number) => void } = {},
): Promise<MediaReport> {
  // The store is used only to place files; URLs are never signed here.
  const store = new FsBlobStore(
    mediaDir,
    new MediaSigner({ secret: new Uint8Array(32) }),
  )
  // Staged beside the store so the final rename stays on one filesystem.
  const staging = path.join(mediaDir, '.staging')
  await mkdir(staging, { recursive: true })
  const report: MediaReport = {
    total: blobs.length,
    copied: 0,
    bytes: 0,
    missing: [],
    mismatched: [],
  }
  let next = 0
  let done = 0
  const worker = async () => {
    while (next < blobs.length) {
      const blob = blobs[next++]
      const input = await source.open(blob.objectKey)
      if (input) {
        const file = path.join(staging, randomUUID())
        const hash = createHash('sha256')
        let size = 0
        const tap = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            hash.update(chunk)
            size += chunk.length
            callback(null, chunk)
          },
        })
        await pipeline(input, tap, createWriteStream(file))
        const digest = hash.digest('hex')
        if (digest === blob.hash && size === blob.size) {
          await store.putFile(blob.hash, file)
          report.copied++
          report.bytes += size
        } else {
          await rm(file, { force: true })
          report.mismatched.push({ blob, hash: digest, size })
        }
      } else {
        report.missing.push(blob)
      }
      options.onProgress?.(++done)
    }
  }
  await Promise.all(
    Array.from({ length: options.concurrency ?? 8 }, () => worker()),
  )
  await rm(staging, { recursive: true, force: true })
  return report
}
