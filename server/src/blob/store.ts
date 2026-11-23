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
}

const KEY = /^[0-9a-f]{64}$/

export function isBlobKey(key: string): boolean {
  return KEY.test(key)
}

export function assertBlobKey(key: string): void {
  if (!isBlobKey(key)) throw new Error(`Invalid blob key: ${key}`)
}
