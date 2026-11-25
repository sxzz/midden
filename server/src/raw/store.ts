import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { S3Bucket, type ObjectHead } from '#blob/s3.ts'
import { resolveR2Credentials } from '#cloudflare.ts'
import type { Config } from '#config.ts'
import type { Logger } from '#log.ts'

const KEY = /^[0-9a-f]{64}$/
const PLAIN_MD5 = /^[0-9a-f]{32}$/
const CONTENT_TYPE = 'application/zstd'
// About 4x on API responses, at a few ms per megabyte.
const LEVEL = 3

/**
 * Where a body lives in the bucket: by the SHA-256 of its bytes as
 * received, so the same body is stored once whoever fetched it.
 */
export function rawKey(sha256: string): string {
  if (!KEY.test(sha256)) throw new Error(`Invalid raw response key: ${sha256}`)
  return `raw/${sha256}.zst`
}

/** A body here that is not what its hash says: storing cannot fix it. */
export class CorruptRawError extends Error {
  override name = 'CorruptRawError'
}

/** The bucket holds something other than what was stored. */
export class RawMismatchError extends Error {
  override name = 'RawMismatchError'
}

const digest = (algorithm: string, bytes: Uint8Array) =>
  createHash(algorithm).update(bytes).digest('hex')

export interface Packed {
  bytes: Buffer
  /** Hex, as the bucket reports it in the ETag of a one-part object. */
  md5: string
}

/**
 * Compress a body for the bucket. The body must match its hash, and the
 * compressed bytes must give it back before they are stored anywhere.
 */
export function pack(body: Uint8Array, sha256: string): Packed {
  if (digest('sha256', body) !== sha256)
    throw new CorruptRawError(`raw response ${sha256} does not match its hash`)
  const bytes = zstdCompressSync(body, {
    params: { [constants.ZSTD_c_compressionLevel]: LEVEL },
  })
  if (!zstdDecompressSync(bytes).equals(body))
    throw new CorruptRawError(`raw response ${sha256} does not compress back`)
  return { bytes, md5: digest('md5', bytes) }
}

/**
 * What is wrong with a stored object, or undefined when it holds exactly
 * the compressed bytes sent: the size, the ETag (their MD5, as the object
 * was stored in one part) and the hash of the body it was made from.
 */
export function storedProblem(
  head: ObjectHead | undefined,
  expected: { size: number; md5: string; sha256: string },
): string | undefined {
  if (!head) return 'missing'
  if (head.size !== expected.size)
    return `size ${head.size}, expected ${expected.size}`
  if (!head.etag || !PLAIN_MD5.test(head.etag) || head.etag !== expected.md5)
    return `ETag ${head.etag ?? 'missing'}, expected ${expected.md5}`
  if (head.metadata.sha256 !== expected.sha256)
    return `made from ${head.metadata.sha256 ?? 'unknown'}`
}

/**
 * Raw upstream responses in a private bucket, compressed with zstd under
 * `raw/`. Only this process and `raw-migrate` write there; the bucket must
 * never be the public media bucket.
 */
export class RawStore {
  readonly bucket: S3Bucket

  constructor(bucket: S3Bucket) {
    this.bucket = bucket
  }

  /**
   * Store a body and confirm the bucket holds exactly the bytes sent;
   * storing one already there writes it again, harmlessly. Returns the
   * compressed size.
   */
  async put(
    sha256: string,
    body: Uint8Array,
    signal?: AbortSignal,
  ): Promise<number> {
    const packed = pack(body, sha256)
    const key = rawKey(sha256)
    await this.bucket.put(key, packed.bytes, {
      size: packed.bytes.length,
      contentType: CONTENT_TYPE,
      md5: Buffer.from(packed.md5, 'hex').toString('base64'),
      sha256: digest('sha256', packed.bytes),
      metadata: { sha256, size: String(body.length) },
      signal,
    })
    const problem = storedProblem(await this.bucket.head(key), {
      size: packed.bytes.length,
      md5: packed.md5,
      sha256,
    })
    if (problem)
      throw new RawMismatchError(
        `raw response ${sha256} reads back wrong: ${problem}`,
      )
    return packed.bytes.length
  }

  /** The body, checked against its hash. */
  async get(sha256: string, signal?: AbortSignal): Promise<Buffer> {
    const chunks: Buffer[] = []
    for await (const chunk of await this.bucket.get(
      rawKey(sha256),
      undefined,
      signal,
    ))
      chunks.push(chunk as Buffer)
    const body = zstdDecompressSync(Buffer.concat(chunks))
    if (digest('sha256', body) !== sha256)
      throw new RawMismatchError(
        `raw response ${sha256} in the bucket does not match its hash`,
      )
    return body
  }

  /** Deleting a missing object succeeds. */
  delete(sha256: string): Promise<void> {
    return this.bucket.delete(rawKey(sha256))
  }
}

/**
 * The raw response store, when a raw bucket is configured: with its own
 * keys, or R2's keys from the Cloudflare API token, verified now. Rejects
 * with a configuration error when that fails, as the media store does: the
 * server must not start without working credentials.
 */
export async function openRawStore(
  config: Pick<Config, 'raw' | 'cloudflare'>,
  logger: Logger,
): Promise<RawStore | undefined> {
  const raw = config.raw
  if (!raw) return undefined
  // loadConfig requires the token and account without the bucket's own keys.
  const credentials =
    raw.credentials ?? (await resolveR2Credentials(config.cloudflare!, logger))
  return new RawStore(
    new S3Bucket({
      endpoint: raw.endpoint,
      bucket: raw.bucket,
      ...credentials,
    }),
  )
}
