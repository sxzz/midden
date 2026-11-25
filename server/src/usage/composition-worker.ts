// Reads what takes long: every page of the database through dbstat (about
// 18 s on a 2.3 GB database) and every file of the media directory. Runs in
// a worker thread at the lowest priority, on its own read-only connection,
// so the server's event loop and its writes go on meanwhile. Self-contained:
// started by path from composition.ts.
import { lstat, readdir } from 'node:fs/promises'
import { setPriority } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'

export interface CompositionInput {
  databasePath: string
  mediaDir: string
}

export interface CompositionItem {
  name: string
  /** `table` or `index`; SQLite's own b-trees have no schema row. */
  type: string
  /** The table an index belongs to. */
  table: string
  bytes: number
}

export interface CompositionOutput {
  /** Every b-tree, largest first. */
  items: CompositionItem[]
  total_bytes: number
  media: { files: number; bytes: number }
}

function composition(databasePath: string) {
  const db = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const sizes = db
      .prepare(
        'SELECT name, pgsize AS bytes FROM dbstat WHERE aggregate = TRUE',
      )
      .all() as { name: string; bytes: number }[]
    const schema = new Map(
      (
        db
          .prepare(
            "SELECT name, type, tbl_name AS tbl FROM sqlite_schema WHERE type IN ('table', 'index')",
          )
          .all() as { name: string; type: string; tbl: string }[]
      ).map((row) => [row.name, row]),
    )
    const items = sizes
      .map(({ name, bytes }) => ({
        name,
        type: schema.get(name)?.type ?? 'table',
        table: schema.get(name)?.tbl ?? name,
        bytes: Number(bytes),
      }))
      .toSorted((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name))
    return {
      items,
      total_bytes: items.reduce((sum, item) => sum + item.bytes, 0),
    }
  } finally {
    db.close()
  }
}

async function directory(dir: string) {
  let files = 0
  let bytes = 0
  let entries
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true })
  } catch {
    return { files, bytes }
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    try {
      bytes += (await lstat(path.join(entry.parentPath, entry.name))).size
      files++
    } catch {
      // Deleted while counting.
    }
  }
  return { files, bytes }
}

if (parentPort) {
  try {
    // On Linux this lowers only this thread.
    setPriority(19)
  } catch {}
  const input = workerData as CompositionInput
  const output: CompositionOutput = {
    ...composition(input.databasePath),
    media: await directory(input.mediaDir),
  }
  parentPort.postMessage(output)
}
