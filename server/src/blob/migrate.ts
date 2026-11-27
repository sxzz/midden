import { and, asc, count, eq, gt, isNotNull, isNull } from 'drizzle-orm'
import { blobs } from '#db/schema.ts'
import {
  checksumVerdict,
  storedProblem,
  type BucketBlobStore,
  type Verification,
} from './bucket-store.ts'
import { digestFile, digestStream, type Digest } from './digest.ts'
import { localCopyHold } from './local-copy.ts'
import { hexToBase64, type ObjectHead } from './s3.ts'
import { IMMUTABLE, isNotFound, objectPath } from './store.ts'
import type { Database } from '#db/client.ts'

type Blob = typeof blobs.$inferSelect

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
  /**
   * Uploaded again over an object of the wrong size or content, or with no
   * checksum to compare.
   */
  replaced: number
  /** Already in the bucket and kept, by how they were verified. */
  present: Record<Verification, number>
  /** Kept objects whose Content-Type or Cache-Control was set right. */
  headersFixed: number
  /** Recorded as stored in the bucket. */
  marked: number
  /** Recorded by the server's upload job while this ran. */
  uploadedMeanwhile: number
  /** The public URL of one recorded blob, to check by hand. */
  sample?: string
  bytesUploaded: number
  /** Local originals deleted once recorded (or, in a dry run, that would be). */
  localDeleted: number
  localBytes: number
  /** Local originals kept once recorded, for thumbnails (`localCopyHold`). */
  localKept: number
  /** No local file and no verified copy in the bucket. */
  missing: number
  /** The local file does not hash to its key. */
  hashMismatch: number
  failed: number
}

const PAGE = 200
const PROGRESS_MS = 5000

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
 * back, record the blob as stored and delete its local file, as the
 * server's upload job does. Safe to stop and run again: recorded blobs are
 * skipped and the rest re-checked.
 *
 * It runs beside the server, in another process, so the server's media
 * lock does not reach it. It deletes a local file only after recording the
 * blob itself, as the upload job does, and the server's readers fall back
 * to the bucket; a download of the same bytes in between
 * at worst leaves a local copy behind, which `media-prune-local` removes.
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
    present: { sha256: 0, etag: 0, 'rclone-md5': 0, download: 0 },
    headersFixed: 0,
    marked: 0,
    uploadedMeanwhile: 0,
    bytesUploaded: 0,
    localDeleted: 0,
    localBytes: 0,
    localKept: 0,
    missing: 0,
    hashMismatch: 0,
    failed: 0,
  }
  const total = Math.min(countBlobs(db, false), options.limit ?? Infinity)
  print(`${dryRun ? '[dry run] ' : ''}${total} blobs not yet in the bucket`)
  const report = progress(print)
  const status = () =>
    `${summary.blobs}/${total} checked, ${summary.uploaded + summary.replaced} uploaded (${formatBytes(summary.bytesUploaded)}), ${summary.marked} recorded, ${summary.localDeleted} local files ${dryRun ? 'to delete' : 'deleted'}, ${summary.failed + summary.hashMismatch + summary.missing} problems`

  // The server's upload job got there first, and may have deleted the
  // local file this run was about to read.
  const uploadedMeanwhile = (blob: Blob) => {
    const current = db
      .select({ remoteAt: blobs.remoteAt })
      .from(blobs)
      .where(eq(blobs.id, blob.id))
      .get()
    if (!current?.remoteAt) return false
    summary.uploadedMeanwhile++
    return true
  }

  /** Whether this run recorded the blob (in a dry run, would have). */
  const mark = (blob: Blob) => {
    summary.sample ??= store.publicUrl(blob.hash)
    if (!dryRun) {
      const { changes } = db
        .update(blobs)
        .set({ remoteAt: new Date(options.now?.() ?? Date.now()) })
        .where(and(eq(blobs.id, blob.id), isNull(blobs.remoteAt)))
        .run()
      // Recorded by the server meanwhile, or no longer a blob.
      if (!changes) {
        uploadedMeanwhile(blob)
        return false
      }
    }
    summary.marked++
    return true
  }

  // Only after recording: a run cut off in between, or a failed deletion,
  // leaves the file to `media-prune-local`. The record stays either way.
  const deleteLocal = async (blob: Blob, size: number) => {
    if (localCopyHold(db, blob)) {
      summary.localKept++
      return
    }
    try {
      if (!dryRun) await store.deleteLocal(blob.hash)
    } catch (error) {
      summary.failed++
      print(
        `recorded, but deleting the local file failed: ${blob.hash}: ${(error as Error).message}`,
      )
      return
    }
    summary.localDeleted++
    summary.localBytes += size
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
      if (uploadedMeanwhile(blob)) return
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
    // Kept when the size matches and a checksum (or, when downloading, the
    // bytes) agrees with the local file. Without one the object is uploaded
    // again: the bucket's copy becomes the only one.
    let verdict: Verification | false | undefined = false
    if (head?.size === local.size) {
      verdict = checksumVerdict(head, local)
      if (verdict === undefined && options.verifyDownload)
        verdict =
          (await digestStream(await store.bucket.get(path))).sha256 ===
            blob.hash && 'download'
    }
    if (head && verdict) {
      await keep(blob, head, local, verdict)
    } else {
      if (head) {
        summary.replaced++
        const reason =
          head.size === local.size
            ? verdict === false
              ? 'content differs'
              : 'no checksum to compare'
            : `size ${head.size}, expected ${local.size}`
        print(`replacing ${blob.hash}: ${reason}`)
      } else {
        summary.uploaded++
      }
      await upload(blob, local)
    }
    if (mark(blob)) await deleteLocal(blob, local.size)
  }

  await eachConcurrently(
    blobPages(db, false, options.limit),
    options.concurrency ?? 4,
    async (blob) => {
      summary.blobs++
      try {
        await one(blob)
      } catch (error) {
        if (!uploadedMeanwhile(blob)) {
          summary.failed++
          print(`failed ${blob.hash}: ${(error as Error).message}`)
        }
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
  /**
   * Also a thumbnail's file, which stays local, or its thumbnail is still
   * to be rendered from it (see `localCopyHold`).
   */
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
 * The upload job and `media-migrate` delete local originals themselves;
 * this is for what they left: recorded before they did, kept for a
 * thumbnail, or a deletion that failed.
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

  const one = async (blob: Blob) => {
    if (localCopyHold(db, blob)) {
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
    if (!dryRun) await store.deleteLocal(blob.hash)
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
        `recorded in the bucket ${s.marked}${s.uploadedMeanwhile ? ` (and ${s.uploadedMeanwhile} by the server meanwhile)` : ''}${s.sample ? `, e.g. ${s.sample}` : ''}`,
        `${options.dryRun ? 'would delete' : 'deleted'} ${s.localDeleted} local files (${formatBytes(s.localBytes)}), kept ${s.localKept} for thumbnails`,
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
      `already gone ${s.absent}, kept for thumbnails ${s.thumbnails}`,
      `kept unverified ${s.unverified}, kept as wrong in the bucket ${s.mismatched}, failed ${s.failed}`,
    ].join('\n'),
  )
  return s.mismatched + s.failed ? 1 : 0
}
