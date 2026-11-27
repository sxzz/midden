import { readdir, stat, statfs } from 'node:fs/promises'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { blobThumbnails, removedMedia } from '#db/schema.ts'
import type { Database } from '#db/client.ts'

/** Where the deploy keeps its database copies (scripts/deploy.ts). */
export const DEPLOY_BACKUPS = path.join('backups', 'deploy')

/** What the server's own disk holds; every figure is cheap to read. */
export interface LocalUsage {
  database: {
    /** Pages in use or free, from the pragmas: the main file's size. */
    bytes: number
    page_size: number
    pages: number
    freelist_pages: number
    /** The write-ahead log beside it; 0 when there is none. */
    wal_bytes: number
  }
  /**
   * Thumbnails, by the sizes recorded when they were made; `local_*` those
   * not yet moved to the remote store (all of them without one).
   */
  thumbnails: {
    count: number
    bytes: number
    local_count: number
    local_bytes: number
  }
  deploy_backups: { files: number; bytes: number }
  /** The volume holding the data directory, as this process may use it. */
  disk: { free_bytes: number; total_bytes: number }
}

const pragma = (db: Database, name: string): number =>
  Number(
    (
      db.$client.prepare(`PRAGMA ${name}`).get() as
        Record<string, unknown> | undefined
    )?.[name] ?? 0,
  )

async function fileSize(file: string): Promise<number> {
  try {
    return (await stat(file)).size
  } catch {
    return 0
  }
}

async function directorySize(
  dir: string,
): Promise<{ files: number; bytes: number }> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return { files: 0, bytes: 0 }
  }
  let bytes = 0
  let files = 0
  for (const entry of entries) {
    if (!entry.isFile()) continue
    files++
    bytes += await fileSize(path.join(dir, entry.name))
  }
  return { files, bytes }
}

export async function localUsage(options: {
  db: Database
  dataDir: string
  databasePath: string
}): Promise<LocalUsage> {
  const { db, dataDir } = options
  const pageSize = pragma(db, 'page_size')
  const pages = pragma(db, 'page_count')
  // Removed media (已移除) keeps its thumbnail once the blob, and with it
  // its `blob_thumbnails` row, is gone; each file once.
  const files = sql`
    SELECT ${blobThumbnails.size} AS size,
      ${blobThumbnails.remoteAt} IS NULL AS local
    FROM ${blobThumbnails} WHERE ${blobThumbnails.state} = 'ready'
    UNION ALL
    SELECT max(${removedMedia.thumbnailSize}),
      max(${removedMedia.thumbnailRemoteAt} IS NULL)
    FROM ${removedMedia}
    WHERE ${removedMedia.thumbnailKey} IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM ${blobThumbnails}
      WHERE ${blobThumbnails.key} = ${removedMedia.thumbnailKey})
    GROUP BY ${removedMedia.thumbnailKey}`
  const sums = db.get<{
    count: number
    bytes: number
    local_count: number
    local_bytes: number
  }>(sql`
    SELECT count(*) AS count, coalesce(sum(size), 0) AS bytes,
      coalesce(sum(local), 0) AS local_count,
      coalesce(sum(CASE WHEN local THEN size END), 0) AS local_bytes
    FROM (${files})`)
  const thumbnails = {
    count: Number(sums?.count ?? 0),
    bytes: Number(sums?.bytes ?? 0),
    local_count: Number(sums?.local_count ?? 0),
    local_bytes: Number(sums?.local_bytes ?? 0),
  }
  const disk = await statfs(dataDir)
  return {
    database: {
      bytes: pageSize * pages,
      page_size: pageSize,
      pages,
      freelist_pages: pragma(db, 'freelist_count'),
      wal_bytes: await fileSize(`${options.databasePath}-wal`),
    },
    thumbnails,
    deploy_backups: await directorySize(path.join(dataDir, DEPLOY_BACKUPS)),
    disk: {
      free_bytes: disk.bavail * disk.bsize,
      total_bytes: disk.blocks * disk.bsize,
    },
  }
}
