import type { Buffer } from 'node:buffer'
import type { Readable } from 'node:stream'

export interface ByteRange {
  start: number
  /** Inclusive. */
  end: number
}

export interface MediaUrlOptions {
  contentType: string
  /** Offered as the download name; implies `attachment` when set. */
  filename?: string
  /**
   * The object's upload to the remote store is confirmed, so a store with
   * a public address may hand that out instead of a URL of this process.
   */
  remote?: boolean
}

/**
 * Content-addressed media storage. Keys are content hashes, so an object
 * never changes once written. Callers stage the bytes in a local file first
 * (see `staging.ts`), which lets every backend upload with a known size.
 */
export interface BlobStore {
  /**
   * Take in a stream of bytes, hashing them as they come, and hold them
   * until `keep` stores them under their hash or `discard` drops them.
   * Rejects with `TooLargeError` past `maxBytes`, leaving nothing behind.
   */
  receive: (
    body: AsyncIterable<Uint8Array>,
    options?: { signal?: AbortSignal; maxBytes?: number },
  ) => Promise<Incoming>
  /** Size in bytes, or undefined when the object does not exist. */
  stat: (key: string) => Promise<number | undefined>
  read: (key: string, range?: ByteRange) => Promise<Readable>
  delete: (key: string) => Promise<void>
  /** A URL the browser can fetch directly for a limited time. */
  url: (key: string, options: MediaUrlOptions) => string
  /**
   * Copy the local object to the remote store and confirm it arrived
   * intact; `present` when the remote store held it already. Only stores
   * with a remote side have it.
   */
  upload?: (
    key: string,
    contentType: string,
    signal?: AbortSignal,
  ) => Promise<'uploaded' | 'present'>
  /**
   * Delete the local copy of an object whose upload is confirmed, leaving
   * the remote store with the only one. Only stores with a remote side have
   * it.
   */
  deleteLocal?: (key: string) => Promise<void>
}

/** Bytes a store has taken in (`BlobStore.receive`) and not yet kept. */
export interface Incoming {
  /** SHA-256 in hex: the key `keep` stores them under. */
  hash: string
  size: number
  /** The first bytes (up to 64 KiB), to tell the media type and size by. */
  head: Buffer
  /**
   * Store the bytes under `hash`, unless the store holds them already.
   * `remote`: the remote store holds them, confirmed, so they are recorded
   * there from the start (`blobs.remote_at`) and need no upload.
   */
  keep: (contentType: string) => Promise<{ remote: boolean }>
  /** Drop whatever `keep` did not take; harmless after it. */
  discard: () => Promise<void>
}

const KEY = /^[0-9a-f]{64}$/

export function isBlobKey(key: string): boolean {
  return KEY.test(key)
}

export function assertBlobKey(key: string): void {
  if (!isBlobKey(key)) throw new Error(`Invalid blob key: ${key}`)
}

/**
 * Where an object lives below the store's root, locally and in a bucket
 * alike: two levels of fan-out keep directories small, and a copy of the
 * media directory (e.g. with rclone) lands on the same keys.
 */
export function objectPath(key: string): string {
  assertBlobKey(key)
  return `${key.slice(0, 2)}/${key.slice(2, 4)}/${key}`
}

/** Media files never change, so every cache may keep them for good. */
export const IMMUTABLE = 'public, max-age=31536000, immutable'

/** An error for a missing object, as the file system reports one. */
export function notFound(key: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`No such object: ${key}`), {
    code: 'ENOENT',
  })
}

export function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}
