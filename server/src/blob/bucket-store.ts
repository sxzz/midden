import { digestFile, digestStream, type Digest } from './digest.ts'
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
 * How an object already in the bucket was found to hold the right bytes:
 * its SHA-256 checksum, its ETag (the MD5 of an object stored in one part),
 * the MD5 rclone records in metadata for multipart uploads, or a download.
 * The size alone is not enough: once recorded, the local file goes.
 */
export type Verification = 'sha256' | 'etag' | 'rclone-md5' | 'download'

/**
 * What an object's checksums say about holding `digest`: the first that
 * matches, false when any contradicts it, undefined when it carries none.
 */
export function checksumVerdict(
  head: ObjectHead,
  digest: Digest,
): Verification | false | undefined {
  const verdicts: [Verification, boolean][] = []
  if (head.checksumSha256)
    verdicts.push([
      'sha256',
      head.checksumSha256 === hexToBase64(digest.sha256),
    ])
  // A multipart ETag ends in `-<parts>` and says nothing about the bytes.
  if (head.etag && PLAIN_MD5.test(head.etag))
    verdicts.push(['etag', head.etag === digest.md5])
  const rclone = head.metadata.md5chksum
  if (rclone) verdicts.push(['rclone-md5', rclone === hexToBase64(digest.md5)])
  if (verdicts.some(([, ok]) => !ok)) return false
  return verdicts[0]?.[0]
}

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

  /**
   * Copy the local object to the bucket and confirm it arrived intact. An
   * object already there under the key whose checksum matches the local
   * file (copied with rclone, or left by an earlier attempt) is kept, its
   * headers set right on the server if they are not, instead of sending
   * the bytes again. Without a local file, an object there that hashes to
   * the key is kept the same way; otherwise the missing file rejects.
   */
  async upload(
    key: string,
    contentType: string,
    signal?: AbortSignal,
  ): Promise<'uploaded' | 'present'> {
    const file = this.local.path(key)
    const path = objectPath(key)
    let digest: Digest
    try {
      digest = await digestFile(file)
    } catch (error) {
      if (!isNotFound(error)) throw error
      const found = await this.bucket.head(path)
      if (!found) throw error
      const remote = await digestStream(await this.bucket.get(path))
      if (remote.sha256 !== key) throw error
      await this.#keep(path, found, contentType)
      this.#confirm(key, await this.bucket.head(path), remote, contentType)
      return 'present'
    }
    if (digest.sha256 !== key)
      throw new CorruptBlobError(`local file of ${key} does not match its hash`)
    const found = await this.bucket.head(path)
    if (found && found.size === digest.size && checksumVerdict(found, digest)) {
      await this.#keep(path, found, contentType)
      this.#confirm(key, await this.bucket.head(path), digest, contentType)
      return 'present'
    }
    await this.bucket.put(path, file, {
      size: digest.size,
      contentType,
      cacheControl: IMMUTABLE,
      sha256: key,
      md5: hexToBase64(digest.md5),
      signal,
    })
    this.#confirm(key, await this.bucket.head(path), digest, contentType)
    return 'uploaded'
  }

  /** Set an object's headers right on the server, when they are not. */
  async #keep(
    path: string,
    found: ObjectHead,
    contentType: string,
  ): Promise<void> {
    if (found.contentType === contentType && found.cacheControl === IMMUTABLE)
      return
    await this.bucket.replaceHeaders(path, {
      contentType,
      cacheControl: IMMUTABLE,
      metadata: found.metadata,
    })
  }

  #confirm(
    key: string,
    head: ObjectHead | undefined,
    digest: Digest,
    contentType: string,
  ): void {
    const problem = storedProblem(head, {
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
