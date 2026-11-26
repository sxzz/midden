import { Buffer } from 'node:buffer'
// What the load test's WAL holds, by the code that wrote it and by table or
// index: reads the frames of the WAL (each is one page written by one
// commit), finds each frame's commit in the meter's log (wal-meter.ts) by
// its offset, and each page's owner in `dbstat`, as of the first snapshot
// taken after that commit (`PageOwners`: pages change owners as tables
// shrink and grow; the queue's empty at the end). Pages no snapshot lists
// are free or pointer-map pages, told apart by their page numbers.
//
//   node scripts/bench-load/wal-report.ts <database> <meter log> [captures] [from]
import { closeSync, openSync, readFileSync, readSync } from 'node:fs'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'
import type { WalLog } from './wal-meter.ts'

interface Row {
  name: string
  commits: number
  frames: number
}

const MB = 2 ** 20

/** Snapshots of which table or index owns each page, taken during a run. */
export class PageOwners {
  readonly names: string[] = []
  readonly snapshots: { at: number; owners: Map<number, number> }[] = []
  #ids = new Map<string, number>()

  take(db: DatabaseSync): void {
    const owners = new Map<number, number>()
    for (const row of db.prepare('SELECT name, pageno FROM dbstat').all() as {
      name: string
      pageno: number
    }[]) {
      let id = this.#ids.get(row.name)
      if (id === undefined) {
        id = this.names.push(row.name) - 1
        this.#ids.set(row.name, id)
      }
      owners.set(row.pageno, id)
    }
    this.snapshots.push({ at: Date.now(), owners })
  }

  /** The owner as of time `at`: the next snapshot that lists the page. */
  of(page: number, at: number): string | undefined {
    const list = this.snapshots
    let i = list.findIndex((s) => s.at >= at)
    if (i < 0) i = list.length
    for (let j = i; j < list.length; j++) {
      const id = list[j]!.owners.get(page)
      if (id !== undefined) return this.names[id]
    }
    for (let j = i - 1; j >= 0; j--) {
      const id = list[j]!.owners.get(page)
      if (id !== undefined) return this.names[id]
    }
    return undefined
  }
}

export function walReport(
  database: string,
  log: WalLog,
  owners: PageOwners,
  captures: number,
  /** WAL offset to start at: what was written before is left out. */
  from = 32,
): string {
  const wal = `${database}-wal`
  const fd = openSync(wal, 'r')
  const header = Buffer.alloc(32)
  readSync(fd, header, 0, 32, 0)
  const pageSize = header.readUInt32BE(8)
  const salt = [header.readUInt32BE(16), header.readUInt32BE(20)]
  const frameSize = pageSize + 24
  const db = new DatabaseSync(database, { readOnly: true })
  owners.take(db)
  // With auto_vacuum, every (usable / 5 + 1)th page from page 2 is a
  // pointer map; the rest that dbstat leaves out are free.
  const autoVacuum = (
    db.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }
  ).auto_vacuum
  const reserved = (() => {
    const head = Buffer.alloc(100)
    const file = openSync(database, 'r')
    readSync(file, head, 0, 100, 0)
    closeSync(file)
    return head[20]!
  })()
  const span = Math.floor((pageSize - reserved) / 5) + 1
  const unowned = (page: number) =>
    autoVacuum && page >= 2 && (page - 2) % span === 0
      ? '(pointer map)'
      : '(free)'
  db.close()

  const byLabel = new Map<number, Row & { pages: Map<string, number> }>()
  const byOwner = new Map<string, number>()
  const frameHeader = Buffer.alloc(24)
  let commit = 0
  let frames = 0
  let lastCommitAt = 0
  // Distinct pages per 10 s: what Litestream's L0 files hold.
  const windows = new Map<number, Set<number>>()
  const start = 32 + Math.ceil(Math.max(0, from - 32) / frameSize) * frameSize
  for (let offset = start; ; offset += frameSize) {
    if (readSync(fd, frameHeader, 0, 24, offset) < 24) break
    if (
      frameHeader.readUInt32BE(8) !== salt[0] ||
      frameHeader.readUInt32BE(12) !== salt[1]
    )
      break
    const page = frameHeader.readUInt32BE(0)
    frames++
    while (commit < log.commits.length && log.commits[commit]!.end <= offset)
      commit++
    const entry = log.commits[commit]
    const label = entry?.label ?? -1
    let row = byLabel.get(label)
    if (!row) {
      row = {
        name: log.labels[label] ?? '(before the meter)',
        commits: 0,
        frames: 0,
        pages: new Map(),
      }
      byLabel.set(label, row)
    }
    row.frames++
    if (frameHeader.readUInt32BE(4) !== 0) row.commits++
    const name = owners.of(page, entry?.at ?? Infinity) ?? unowned(page)
    row.pages.set(name, (row.pages.get(name) ?? 0) + 1)
    byOwner.set(name, (byOwner.get(name) ?? 0) + 1)
    if (entry) {
      lastCommitAt = entry.at
      const window = Math.floor(entry.at / 10_000)
      let set = windows.get(window)
      if (!set) windows.set(window, (set = new Set()))
      set.add(page)
    }
  }
  closeSync(fd)

  const bytes = (n: number) => n * frameSize
  const lines: string[] = []
  const first = log.commits[0]?.at ?? lastCommitAt
  const seconds = Math.max(1, (lastCommitAt - first) / 1000)
  const distinct = windows.values().reduce((sum, s) => sum + s.size, 0)
  lines.push(
    `WAL ${(bytes(frames) / MB).toFixed(1)} MB, ${frames} frames, ${log.commits.length} commits in ${seconds.toFixed(0)} s (${(bytes(frames) / MB / seconds).toFixed(2)} MB/s); ` +
      `distinct pages per 10 s window: ${(bytes(distinct) / MB).toFixed(1)} MB; ` +
      `captures ${captures}: ${captures ? (bytes(frames) / captures / 1024).toFixed(1) : '-'} KiB each`,
    '',
    'by code (top 30): MB, % of WAL, commits, frames/commit, KiB/capture, top pages',
  )
  const labels = [...byLabel.values()].toSorted((a, b) => b.frames - a.frames)
  for (const row of labels.slice(0, 30)) {
    const top = [...row.pages]
      .toSorted((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([name, n]) => `${name} ${Math.round((n / row.frames) * 100)}%`)
      .join(', ')
    lines.push(
      `${(bytes(row.frames) / MB).toFixed(1).padStart(8)} ${((row.frames / frames) * 100).toFixed(1).padStart(5)}% ${String(row.commits).padStart(7)} ${(row.frames / Math.max(1, row.commits)).toFixed(1).padStart(6)} ${captures ? (bytes(row.frames) / captures / 1024).toFixed(1).padStart(7) : ''}  ${row.name}`,
      `${' '.repeat(40)}${top}`,
    )
    const index = log.labels.indexOf(row.name)
    const statements = log.statements[index]
    if (statements)
      lines.push(
        `${' '.repeat(40)}${Object.entries(statements)
          .toSorted((a, b) => b[1] - a[1])
          .slice(0, 12)
          .map(([k, n]) => `${k} ×${n}`)
          .join(', ')}`,
      )
  }
  lines.push('', 'by table or index (top 30): MB, % of WAL')
  for (const [name, n] of [...byOwner]
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, 30))
    lines.push(
      `${(bytes(n) / MB).toFixed(1).padStart(8)} ${((n / frames) * 100).toFixed(1).padStart(5)}%  ${name}`,
    )
  return lines.join('\n')
}

if (import.meta.main) {
  const [database, logFile, captures, from] = process.argv.slice(2)
  if (!database || !logFile) {
    console.error(
      'usage: wal-report.ts <database> <meter log> [captures] [from]',
    )
    process.exit(2)
  }
  const log = JSON.parse(readFileSync(logFile, 'utf8')) as WalLog
  // Only the owners at the end: pages freed since then count as free.
  console.info(
    walReport(
      database,
      log,
      new PageOwners(),
      Number(captures ?? 0),
      Number(from ?? 32),
    ),
  )
}
