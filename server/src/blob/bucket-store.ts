import { digestFile } from './digest.ts'
import { hexToBase64, type ObjectHead, type S3Bucket } from './s3.ts'
import {
  IMMUTABLE,
  isNotFound,
  objectPath,
  type BlobStore,
  type ByteRange,
  type MediaUrlOptions,
} from './store.ts'
import type { FsBlobStore } from './fs-store.ts'
import type { Purge } from './purge.ts'
import type { Readable } from 'node:stream'

export interface BucketStoreOptions {
  /** Where media is written first, and thumbnails stay. */
  local: FsBlobStore
  bucket: S3Bucket
  /** Serves the bucket publicly: an object's URL is this plus its key. */
  publicUrl: string
  purge: Purge
}

/** The local file no longer holds the bytes its key names. */
export class CorruptBlobError extends Error {
  override name = 'CorruptBlobError'
}

/** The bucket did not end up holding what was uploaded. */
export class UploadMismatchError extends Error {
  override name = 'UploadMismatchError'
}

const PLAIN_MD5 = /^[0-9a-f]{32}$/
const TRAILING_SLASHES = /\/+$/

/**
 * What is wrong with a stored object, or undefined when it has the right
 * size and headers. The ETag is compared when it is a plain MD5, which it
 * is for an object stored in one part.
 */
export function storedProblem(
  head: ObjectHead | undefined,
  expected: { size: number; contentType: string; md5?: string },
): string | undefined {
  if (!head) return 'missing'
  if (head.size !== expected.size)
    return `size ${head.size}, expected ${expected.size}`
  if (
    expected.md5 &&
    head.etag &&
    PLAIN_MD5.test(head.etag) &&
    head.etag !== expected.md5
  )
    return 'ETag differs from the MD5'
  if (head.contentType !== expected.contentType)
    return `Content-Type ${head.contentType ?? 'missing'}`
  if (head.cacheControl !== IMMUTABLE)
    return `Cache-Control ${head.cacheControl ?? 'missing'}`
}

/**
 * Media in an S3 bucket (Cloudflare R2), served publicly from its own
 * domain, with a local directory in front: downloads land there first and
 * a job uploads them, then deletes the local original (see
 * `capture/upload.ts`); thumbnails only ever live there, and reads prefer
 * it. Only uploads confirmed in the bucket get its public URL; everything
 * else goes through this process's signed URLs.
 */
export class BucketBlobStore implements BlobStore {
  readonly local: FsBlobStore
  readonly bucket: S3Bucket
  readonly #publicUrl: string
  readonly #purge: Purge

  constructor(options: BucketStoreOptions) {
    this.local = options.local
    this.bucket = options.bucket
    this.#publicUrl = options.publicUrl.replace(TRAILING_SLASHES, '')
    this.#purge = options.purge
  }

  publicUrl(key: string): string {
    return `${this.#publicUrl}/${objectPath(key)}`
  }

  putFile(key: string, file: string): Promise<void> {
    return this.local.putFile(key, file)
  }

  async stat(key: string): Promise<number | undefined> {
    return (
      (await this.local.stat(key)) ??
      (await this.bucket.head(objectPath(key)))?.size
    )
  }

  async read(key: string, range?: ByteRange): Promise<Readable> {
    try {
      return await this.local.read(key, range)
    } catch (error) {
      if (!isNotFound(error)) throw error
      return this.bucket.get(objectPath(key), range)
    }
  }

  deleteLocal(key: string): Promise<void> {
    return this.local.delete(key)
  }

  /** Local copy, bucket object and the edge's cached copy. */
  async delete(key: string): Promise<void> {
    await this.local.delete(key)
    const path = objectPath(key)
    if (!(await this.bucket.head(path))) return
    // Purged before the object goes: when the purge fails, the object and
    // its garbage entry stay for the next attempt, which purges again. The
    // other way round, a failed purge would leave nothing to retry by.
    await this.#purge(this.publicUrl(key))
    await this.bucket.delete(path)
  }

  url(key: string, options: MediaUrlOptions): string {
    // A download needs Content-Disposition, which the bucket cannot vary
    // per request: it streams through this process.
    if (options.remote && !options.filename) return this.publicUrl(key)
    return this.local.url(key, options)
  }

  async upload(
    key: string,
    contentType: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const file = this.local.path(key)
    const digest = await digestFile(file)
    if (digest.sha256 !== key)
      throw new CorruptBlobError(`local file of ${key} does not match its hash`)
    const path = objectPath(key)
    await this.bucket.put(path, file, {
      size: digest.size,
      contentType,
      cacheControl: IMMUTABLE,
      sha256: key,
      md5: hexToBase64(digest.md5),
      signal,
    })
    const problem = storedProblem(await this.bucket.head(path), {
      size: digest.size,
      contentType,
      md5: digest.md5,
    })
    if (problem)
      throw new UploadMismatchError(
        `uploaded ${key} reads back wrong: ${problem}`,
      )
  }
}
