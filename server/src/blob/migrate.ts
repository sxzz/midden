import { rm } from 'node:fs/promises'
import { and, asc, count, eq, gt, isNotNull, isNull } from 'drizzle-orm'
import { blobs, blobThumbnails, removedMedia } from '#db/schema.ts'
import { storedProblem, type BucketBlobStore } from './bucket-store.ts'
import { digestFile, digestStream, type Digest } from './digest.ts'
import { hexToBase64, type ObjectHead } from './s3.ts'
import { IMMUTABLE, isNotFound, objectPath } from './store.ts'
import type { Database } from '#db/client.ts'

type Blob = typeof blobs.$inferSelect

/**
 * How an object already in the bucket was found to hold the right bytes:
 * its SHA-256 checksum, its ETag (the MD5 of an object stored in one part),
 * the MD5 rclone records in metadata for multipart uploads, a download, or
 * only its size.
 */
export type Verification =
  'sha256' | 'etag' | 'rclone-md5' | 'download' | 'size'

export interface MediaToolOptions {
  dryRun?: boolean
  concurrency?: number
  /** Download objects with no checksum to compare, and hash them. */
  verifyDownload?: boolean
  /** Stop after this many blobs. */
  limit?: number
  print: (line: string) => void
  now?: () => number
}

export interface MigrateSummary {
  /** Blobs not yet in the bucket that were looked at. */
  blobs: number
  /** Uploaded: not in the bucket before. */
  uploaded: number
  /** Uploaded again over an object of the wrong size or content. */
  replaced: number
  /** Already in the bucket and kept, by how they were verified. */
  present: Record<Verification, number>
  /** Kept objects whose Content-Type or Cache-Control was set right. */
  headersFixed: number
  /** Recorded as stored in the bucket. */
  marked: number
  /** The public URL of one recorded blob, to check by hand. */
  sample?: string
  bytesUploaded: number
  /** No local file and no verified copy in the bucket. */
  missing: number
  /** The local file does not hash to its key. */
  hashMismatch: number
  failed: number
}

const PAGE = 200
const PLAIN_MD5 = /^[0-9a-f]{32}$/
const PROGRESS_MS = 5000

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

function countBlobs(db: Database, remote: boolean): number {
  return db
    .select({ n: count() })
    .from(blobs)
    .where(remote ? isNotNull(blobs.remoteAt) : isNull(blobs.remoteAt))
    .get()!.n
}

async function* blobPages(
  db: Database,
  remote: boolean,
  limit = Infinity,
): AsyncGenerator<Blob> {
  let last = ''
  let count = 0
  for (;;) {
    const rows = db
      .select()
      .from(blobs)
      .where(
        and(
          remote ? isNotNull(blobs.remoteAt) : isNull(blobs.remoteAt),
          gt(blobs.id, last),
        ),
      )
      .orderBy(asc(blobs.id))
      .limit(PAGE)
      .all()
    if (!rows.length) return
    for (const row of rows) {
      if (count++ >= limit) return
      yield row
    }
    last = rows.at(-1)!.id
  }
}

async function eachConcurrently<T>(
  items: AsyncIterable<T>,
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const iterator = items[Symbol.asyncIterator]()
  const worker = async () => {
    for (;;) {
      const next = await iterator.next()
      if (next.done) return
      await fn(next.value)
    }
  }
  await Promise.all(Array.from({ length: Math.max(concurrency, 1) }, worker))
}

function progress(print: (line: string) => void) {
  let last = Date.now()
  return (line: () => string, force = false) => {
    if (!force && Date.now() - last < PROGRESS_MS) return
    last = Date.now()
    print(line())
  }
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`
}

async function localDigest(
  store: BucketBlobStore,
  key: string,
): Promise<Digest | undefined> {
  try {
    return await digestFile(store.local.path(key))
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw error
  }
}

/**
 * Upload every blob not yet recorded in the bucket (`media-migrate`):
 * hash the local file first, keep an object already there (copied with
 * rclone, or by an interrupted run) when its size and checksum match,
 * fixing its headers on the server, otherwise upload; then read the object
 * back and record the blob as stored. Never deletes local files. Safe to
 * stop and run again: recorded blobs are skipped and the rest re-checked.
 */
export async function migrateMedia(
  db: Database,
  store: BucketBlobStore,
  options: MediaToolOptions,
): Promise<MigrateSummary> {
  const { print } = options
  const dryRun = !!options.dryRun
  const summary: MigrateSummary = {
    blobs: 0,
    uploaded: 0,
    replaced: 0,
    present: { sha256: 0, etag: 0, 'rclone-md5': 0, download: 0, size: 0 },
    headersFixed: 0,
    marked: 0,
    bytesUploaded: 0,
    missing: 0,
    hashMismatch: 0,
    failed: 0,
  }
  const total = Math.min(countBlobs(db, false), options.limit ?? Infinity)
  print(`${dryRun ? '[dry run] ' : ''}${total} blobs not yet in the bucket`)
  const report = progress(print)
  const status = () =>
    `${summary.blobs}/${total} checked, ${summary.uploaded + summary.replaced} uploaded (${formatBytes(summary.bytesUploaded)}), ${summary.marked} recorded, ${summary.failed + summary.hashMismatch + summary.missing} problems`

  const mark = (blob: Blob) => {
    summary.marked++
    summary.sample ??= store.publicUrl(blob.hash)
    if (dryRun) return
    db.update(blobs)
      .set({ remoteAt: new Date(options.now?.() ?? Date.now()) })
      .where(and(eq(blobs.id, blob.id), isNull(blobs.remoteAt)))
      .run()
  }

  const upload = async (blob: Blob, digest: Digest) => {
    if (dryRun) return
    const path = objectPath(blob.hash)
    await store.bucket.put(path, store.local.path(blob.hash), {
      size: digest.size,
      contentType: blob.mime,
      cacheControl: IMMUTABLE,
      sha256: blob.hash,
      md5: hexToBase64(digest.md5),
    })
    const problem = storedProblem(await store.bucket.head(path), {
      size: digest.size,
      contentType: blob.mime,
      md5: digest.md5,
    })
    if (problem) throw new Error(`reads back wrong after upload: ${problem}`)
    summary.bytesUploaded += digest.size
  }

  const keep = async (
    blob: Blob,
    head: ObjectHead,
    digest: Digest,
    verification: Verification,
  ) => {
    summary.present[verification]++
    if (head.contentType === blob.mime && head.cacheControl === IMMUTABLE)
      return
    summary.headersFixed++
    if (dryRun) return
    const path = objectPath(blob.hash)
    await store.bucket.replaceHeaders(path, {
      contentType: blob.mime,
      cacheControl: IMMUTABLE,
      metadata: head.metadata,
    })
    const problem = storedProblem(await store.bucket.head(path), {
      size: digest.size,
      contentType: blob.mime,
    })
    if (problem) throw new Error(`headers still wrong after copy: ${problem}`)
  }

  const one = async (blob: Blob) => {
    const path = objectPath(blob.hash)
    const local = await localDigest(store, blob.hash)
    if (local && local.sha256 !== blob.hash) {
      summary.hashMismatch++
      print(`hash mismatch, not uploaded: ${blob.hash}`)
      return
    }
    const head = await store.bucket.head(path)
    if (!local) {
      // Only a copy in the bucket that hashes to the key can stand in.
      const remote =
        head && options.verifyDownload
          ? await digestStream(await store.bucket.get(path))
          : undefined
      if (!head || remote?.sha256 !== blob.hash) {
        summary.missing++
        print(
          `missing locally${head ? ', unverified in the bucket' : ''}: ${blob.hash}`,
        )
        return
      }
      await keep(blob, head, remote, 'download')
      mark(blob)
      return
    }
    // Kept when the size matches and no checksum contradicts the local
    // file; with no checksum at all, by size alone unless downloading.
    let verdict: Verification | false = false
    if (head?.size === local.size) {
      verdict = checksumVerdict(head, local) ?? 'size'
      if (verdict === 'size' && options.verifyDownload)
        verdict =
          (await digestStream(await store.bucket.get(path))).sha256 ===
            blob.hash && 'download'
    }
    if (head && verdict) {
      await keep(blob, head, local, verdict)
    } else {
      if (head) {
        summary.replaced++
        print(
          `replacing ${blob.hash}: ${head.size === local.size ? 'content differs' : `size ${head.size}, expected ${local.size}`}`,
        )
      } else {
        summary.uploaded++
      }
      await upload(blob, local)
    }
    mark(blob)
  }

  await eachConcurrently(
    blobPages(db, false, options.limit),
    options.concurrency ?? 4,
    async (blob) => {
      summary.blobs++
      try {
        await one(blob)
      } catch (error) {
        summary.failed++
        print(`failed ${blob.hash}: ${(error as Error).message}`)
      }
      report(status)
    },
  )
  report(status, true)
  return summary
}

export interface PruneSummary {
  /** Blobs recorded in the bucket that were looked at. */
  blobs: number
  /** Local files deleted (or, in a dry run, that would be). */
  deleted: number
  bytes: number
  /** Already gone locally. */
  absent: number
  /** Also a thumbnail's file, which stays local. */
  thumbnails: number
  /** The bucket's object carries no checksum; kept without a download. */
  unverified: number
  /** The bucket's object is wrong: kept, and no longer recorded there. */
  mismatched: number
  failed: number
}

/**
 * Delete local originals whose object in the bucket is confirmed
 * (`media-prune-local`): recorded there, the right size and headers, and a
 * checksum (or, with `verifyDownload`, the downloaded bytes) matching the
 * local file. Thumbnails stay. An object found wrong is no longer recorded,
 * so the web goes back to the local file and the next migration uploads it.
 */
export async function pruneLocalMedia(
  db: Database,
  store: BucketBlobStore,
  options: MediaToolOptions,
): Promise<PruneSummary> {
  const { print } = options
  const dryRun = !!options.dryRun
  const summary: PruneSummary = {
    blobs: 0,
    deleted: 0,
    bytes: 0,
    absent: 0,
    thumbnails: 0,
    unverified: 0,
    mismatched: 0,
    failed: 0,
  }
  const total = Math.min(countBlobs(db, true), options.limit ?? Infinity)
  print(`${dryRun ? '[dry run] ' : ''}${total} blobs recorded in the bucket`)
  const report = progress(print)
  const status = () =>
    `${summary.blobs}/${total} checked, ${summary.deleted} local files ${dryRun ? 'to delete' : 'deleted'} (${formatBytes(summary.bytes)})`

  const isThumbnail = (key: string) =>
    !!db
      .select({ id: blobThumbnails.blobId })
      .from(blobThumbnails)
      .where(eq(blobThumbnails.key, key))
      .get() ||
    !!db
      .select({ id: removedMedia.mediaKey })
      .from(removedMedia)
      .where(eq(removedMedia.thumbnailKey, key))
      .get()

  const one = async (blob: Blob) => {
    if (isThumbnail(blob.hash)) {
      summary.thumbnails++
      return
    }
    const local = await localDigest(store, blob.hash)
    if (!local) {
      summary.absent++
      return
    }
    const path = objectPath(blob.hash)
    const head = await store.bucket.head(path)
    let problem = storedProblem(head, {
      size: local.size,
      contentType: blob.mime,
    })
    let verdict = !problem && head ? checksumVerdict(head, local) : undefined
    if (!problem && verdict === undefined && options.verifyDownload)
      verdict =
        (await digestStream(await store.bucket.get(path))).sha256 ===
          local.sha256 && 'download'
    if (verdict === false) problem = 'content differs from the local file'
    if (problem) {
      summary.mismatched++
      print(`kept ${blob.hash}: the bucket's copy is wrong (${problem})`)
      if (!dryRun)
        db.update(blobs)
          .set({ remoteAt: null })
          .where(eq(blobs.id, blob.id))
          .run()
      return
    }
    if (verdict === undefined) {
      summary.unverified++
      print(`kept ${blob.hash}: no checksum to compare (try --verify-download)`)
      return
    }
    summary.deleted++
    summary.bytes += local.size
    if (!dryRun) await rm(store.local.path(blob.hash), { force: true })
  }

  await eachConcurrently(
    blobPages(db, true, options.limit),
    options.concurrency ?? 4,
    async (blob) => {
      summary.blobs++
      try {
        await one(blob)
      } catch (error) {
        summary.failed++
        print(`failed ${blob.hash}: ${(error as Error).message}`)
      }
      report(status)
    },
  )
  report(status, true)
  return summary
}

/** Run `media-migrate` or `media-prune-local`; the exit code. */
export async function mediaCommand(
  command: 'media-migrate' | 'media-prune-local',
  db: Database,
  store: BucketBlobStore,
  options: MediaToolOptions,
): Promise<number> {
  const { print } = options
  const prefix = options.dryRun ? '[dry run] ' : ''
  if (command === 'media-migrate') {
    const s = await migrateMedia(db, store, options)
    const present = Object.entries(s.present)
      .filter(([, n]) => n)
      .map(([how, n]) => `${n} by ${how}`)
      .join(', ')
    print(
      [
        `${prefix}checked ${s.blobs} blobs`,
        `uploaded ${s.uploaded} (${formatBytes(s.bytesUploaded)}), replaced ${s.replaced}`,
        `already in the bucket ${Object.values(s.present).reduce((a, b) => a + b, 0)}${present ? ` (verified ${present})` : ''}, headers fixed ${s.headersFixed}`,
        `recorded in the bucket ${s.marked}${s.sample ? `, e.g. ${s.sample}` : ''}`,
        `missing locally ${s.missing}, hash mismatch ${s.hashMismatch}, failed ${s.failed}`,
      ].join('\n'),
    )
    return s.missing + s.hashMismatch + s.failed ? 1 : 0
  }
  const s = await pruneLocalMedia(db, store, options)
  print(
    [
      `${prefix}checked ${s.blobs} blobs`,
      `${options.dryRun ? 'would delete' : 'deleted'} ${s.deleted} local files (${formatBytes(s.bytes)})`,
      `already gone ${s.absent}, kept as thumbnails ${s.thumbnails}`,
      `kept unverified ${s.unverified}, kept as wrong in the bucket ${s.mismatched}, failed ${s.failed}`,
    ].join('\n'),
  )
  return s.mismatched + s.failed ? 1 : 0
}
