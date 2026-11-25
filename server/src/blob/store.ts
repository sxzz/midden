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
  /** Store the staged file under `key`, consuming it. */
  putFile: (key: string, file: string) => Promise<void>
  /** Size in bytes, or undefined when the object does not exist. */
  stat: (key: string) => Promise<number | undefined>
  read: (key: string, range?: ByteRange) => Promise<Readable>
  delete: (key: string) => Promise<void>
  /** A URL the browser can fetch directly for a limited time. */
  url: (key: string, options: MediaUrlOptions) => string
  /**
   * Where a program such as ffmpeg can read the object: a local path, or a
   * URL it may fetch by byte ranges. Rejects when the object is missing.
   */
  source: (key: string) => Promise<string>
  /**
   * Copy the local object to the remote store and confirm it arrived
   * intact. Only stores with a remote side have it.
   */
  upload?: (
    key: string,
    contentType: string,
    signal?: AbortSignal,
  ) => Promise<void>
  /**
   * Delete the local copy of an object whose upload is confirmed, leaving
   * the remote store with the only one. Only stores with a remote side have
   * it.
   */
  deleteLocal?: (key: string) => Promise<void>
}

const URL_SOURCE = /^https?:/

/**
 * Run a program on the object (see `BlobStore.source`). A local file can be
 * deleted between being found and the program opening it, once its upload
 * is confirmed (see `capture/upload.ts`); then the program runs once more,
 * on the remote copy. A file the program has opened stays readable.
 */
export async function withSource<T>(
  store: BlobStore,
  key: string,
  use: (input: string) => Promise<T>,
): Promise<T> {
  const input = await store.source(key)
  try {
    return await use(input)
  } catch (error) {
    if (URL_SOURCE.test(input)) throw error
    const again = await store.source(key).catch(() => input)
    if (again === input) throw error
    return use(again)
  }
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
