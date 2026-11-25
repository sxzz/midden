import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { isRateLimited, S3Bucket, type ObjectHead } from '#blob/s3.ts'
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
 * The bucket is rate-limiting: its requests wait this long. Every request
 * of the store waits out one pause together (`RawStore.pausedFor`).
 */
export class RawRateLimitError extends Error {
  override name = 'RawRateLimitError'
  readonly afterMs: number
  /** This request met the limit; the others met the pause it began. */
  readonly started: boolean
  constructor(afterMs: number, started: boolean, options?: ErrorOptions) {
    super(`the raw bucket is rate-limited for ${afterMs} ms`, options)
    this.afterMs = afterMs
    this.started = started
  }
}

export interface RawStoreOptions {
  /**
   * The first pause after a rate limit without `Retry-After`; it doubles
   * while limits follow one another, up to five minutes.
   */
  pauseMs?: number
  now?: () => number
}

const FIRST_PAUSE = 5000
const LONGEST_PAUSE = 5 * 60_000

/** What storing a body did. */
export interface Stored {
  /** Compressed size. */
  bytes: number
  /** False when the bucket already held it. */
  uploaded: boolean
}

/**
 * Raw upstream responses in a private bucket, compressed with zstd under
 * `raw/`. Only this process and `raw-migrate` write there; the bucket must
 * never be the public media bucket.
 *
 * R2 takes about one write a second to one key and answers faster ones
 * with 429. The S3 client waits and tries again a few times; when the
 * limit outlasts that, the store pauses all its requests (the policy: when
 * an API rate-limits, its tasks wait until it recovers) and each call
 * meanwhile rejects with `RawRateLimitError` without a request.
 */
export class RawStore {
  readonly bucket: S3Bucket
  readonly #pauseMs: number
  readonly #now: () => number
  #pausedUntil = 0
  /** Pauses in a row, without a request that went through between. */
  #pauses = 0

  constructor(bucket: S3Bucket, options: RawStoreOptions = {}) {
    this.bucket = bucket
    this.#pauseMs = options.pauseMs ?? FIRST_PAUSE
    this.#now = options.now ?? Date.now
  }

  /** How long requests still wait after a rate limit; 0 when they go. */
  pausedFor(): number {
    return Math.max(this.#pausedUntil - this.#now(), 0)
  }

  async #call<T>(request: () => Promise<T>): Promise<T> {
    const waiting = this.pausedFor()
    if (waiting) throw new RawRateLimitError(waiting, false)
    try {
      const result = await request()
      this.#pauses = 0
      return result
    } catch (error) {
      if (!isRateLimited(error)) throw error
      // Requests under way when another began the pause join it.
      const started = !this.pausedFor()
      const wait =
        error.retryAfterMs ??
        Math.min(this.#pauseMs * 2 ** this.#pauses, LONGEST_PAUSE)
      if (started) this.#pauses++
      this.#pausedUntil = Math.max(this.#pausedUntil, this.#now() + wait)
      throw new RawRateLimitError(this.pausedFor(), started, { cause: error })
    }
  }

  async #problem(sha256: string, packed: Packed): Promise<string | undefined> {
    return storedProblem(
      await this.#call(() => this.bucket.head(rawKey(sha256))),
      { size: packed.bytes.length, md5: packed.md5, sha256 },
    )
  }

  /**
   * Store a body and confirm the bucket holds exactly the bytes sent. With
   * `check`, an object already there that reads back right (size, ETag and
   * the hash it was made from) is kept without an upload; otherwise
   * storing one already there writes it again, harmlessly.
   */
  async store(
    sha256: string,
    body: Uint8Array,
    options: { check?: boolean; signal?: AbortSignal } = {},
  ): Promise<Stored> {
    const packed = pack(body, sha256)
    const bytes = packed.bytes.length
    if (options.check && !(await this.#problem(sha256, packed)))
      return { bytes, uploaded: false }
    await this.#call(() =>
      this.bucket.put(rawKey(sha256), packed.bytes, {
        size: bytes,
        contentType: CONTENT_TYPE,
        md5: Buffer.from(packed.md5, 'hex').toString('base64'),
        sha256: digest('sha256', packed.bytes),
        metadata: { sha256, size: String(body.length) },
        signal: options.signal,
      }),
    )
    const problem = await this.#problem(sha256, packed)
    if (problem)
      throw new RawMismatchError(
        `raw response ${sha256} reads back wrong: ${problem}`,
      )
    return { bytes, uploaded: true }
  }

  /** The body, checked against its hash. */
  async get(sha256: string, signal?: AbortSignal): Promise<Buffer> {
    const stream = await this.#call(() =>
      this.bucket.get(rawKey(sha256), undefined, signal),
    )
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(chunk as Buffer)
    const body = zstdDecompressSync(Buffer.concat(chunks))
    if (digest('sha256', body) !== sha256)
      throw new RawMismatchError(
        `raw response ${sha256} in the bucket does not match its hash`,
      )
    return body
  }

  /** Deleting a missing object succeeds. */
  delete(sha256: string): Promise<void> {
    return this.#call(() => this.bucket.delete(rawKey(sha256)))
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
