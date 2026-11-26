import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  checkSearchIndexes,
  intact,
  optimizeSearchIndexes,
  rebuildSearchIndexes,
} from '#library/search-index.ts'
import {
  openDatabase,
  pendingMigrations,
  unknownMigrations,
  type Database,
} from './client.ts'

export interface MaintainOptions {
  /**
   * Compact the database: write a vacuumed copy next to it, check it, and
   * put it in its place. The original, with its WAL, is kept in `backupDir`.
   */
  vacuum?: boolean
  /** Build the search indexes again even when they check out. */
  rebuildSearch?: boolean
  /** Where the original goes; `backups/maintain` beside the database. */
  backupDir?: string
  print: (line: string) => void
  now?: () => Date
}

const MIB = 1024 * 1024
const OLD_BACKUP = /^midden-.+\.db(?:-wal)?$/
const size = (bytes: number) =>
  `${(bytes / MIB).toLocaleString('en-US', { maximumFractionDigits: 1 })} MiB`
const fileSize = (file: string) => (existsSync(file) ? statSync(file).size : 0)

function timed<T>(print: (line: string) => void, label: string, fn: () => T) {
  const start = performance.now()
  const result = fn()
  print(`${label} (${((performance.now() - start) / 1000).toFixed(1)} s)`)
  return result
}

/** SQLite's full integrity check; its problems, none when sound. */
function integrity(db: Database): string[] {
  const rows = db.$client.prepare('PRAGMA integrity_check').all()
  const lines = rows.map((row) => String(row.integrity_check))
  return lines.length === 1 && lines[0] === 'ok' ? [] : lines
}

function pages(db: Database) {
  const get = (name: string) =>
    Number(db.$client.prepare(`PRAGMA ${name}`).get()?.[name] ?? 0)
  const pageSize = get('page_size')
  return {
    bytes: get('page_count') * pageSize,
    free: get('freelist_count') * pageSize,
  }
}

/** Write a file's data, and then its directory entry, to the disk. */
function sync(file: string) {
  for (const target of [file, path.dirname(file)]) {
    const fd = openSync(target, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }
}

/**
 * Offline maintenance of the database at `file`, with every process that
 * uses it stopped (web, worker, Litestream; it refuses to start while any
 * connection is open): an integrity check; with `vacuum`, a full vacuum
 * into a new file; the search indexes checked, and rebuilt if they do not
 * match the catalog; statistics for the query planner; an integrity check
 * of the result; sizes before and after. Returns the exit code.
 */
export function maintainDatabase(
  file: string,
  options: MaintainOptions,
): number {
  const { print } = options
  const stamp = (options.now?.() ?? new Date())
    .toISOString()
    .replaceAll(/[:.]/g, '-')
  let db: Database
  try {
    db = openDatabase(file, { migrate: false, exclusive: true })
  } catch (error) {
    print(
      `could not take the database for itself (${String(error)}); stop the web process, the worker and Litestream first`,
    )
    return 1
  }
  try {
    const pending = pendingMigrations(db)
    const unknown = unknownMigrations(db)
    if (pending || unknown) {
      print(
        pending
          ? `${pending} migrations are pending: start this version's web process once first`
          : `a newer version migrated the database (${unknown} unknown migrations): run its maintain`,
      )
      return 1
    }
    const before = {
      ...pages(db),
      file: fileSize(file),
      wal: fileSize(`${file}-wal`),
    }
    print(
      `before: ${size(before.bytes)} in pages, ${size(before.free)} of them free; file ${size(before.file)}, WAL ${size(before.wal)}`,
    )
    const problems = timed(print, 'integrity check', () => integrity(db))
    if (problems.length) {
      print(`integrity check failed:\n${problems.slice(0, 20).join('\n')}`)
      return 1
    }
    if (!options.vacuum) {
      const code = finish(db, options)
      print(`after: ${size(pages(db).bytes)}`)
      return code
    }

    const copy = `${file}.vacuum-${stamp}`
    const removeCopy = () => {
      for (const suffix of ['', '-wal', '-shm'])
        rmSync(copy + suffix, { force: true })
    }
    removeCopy()
    let code = 1
    try {
      // The copy takes the mode set here: incremental, which maintenance
      // relies on to return free pages, also for a database made before it
      // was the default.
      db.$client.exec('PRAGMA auto_vacuum = INCREMENTAL')
      timed(print, `vacuum into ${path.basename(copy)}`, () =>
        db.$client.prepare('VACUUM INTO ?').run(copy),
      )
      // Closed as the last connection, it writes its WAL back and removes
      // it: the backup is then one file.
      db.$client.close()
      const vacuumed = openDatabase(copy, { migrate: false, exclusive: true })
      let after: ReturnType<typeof pages> | undefined
      try {
        if (finish(vacuumed, options) === 0) after = pages(vacuumed)
      } finally {
        // Closed, it writes its WAL back and removes it.
        vacuumed.$client.close()
      }
      if (after) {
        sync(copy)
        const backup = swap(file, copy, options.backupDir, stamp)
        code = 0
        print(`the original database is now ${backup}`)
        print(
          `after: ${size(after.bytes)}, ${size(after.free)} free; ${size(before.file + before.wal - fileSize(file))} smaller`,
        )
      }
    } finally {
      if (code !== 0) {
        removeCopy()
        print('the original database is unchanged')
      }
    }
    return code
  } finally {
    if (db.$client.isOpen) db.$client.close()
  }
}

/**
 * The steps after the vacuum, on the database that is kept: the search
 * indexes, the planner's statistics, an integrity check.
 */
function finish(db: Database, options: MaintainOptions): number {
  const { print } = options
  const checks = timed(print, 'search index check', () =>
    checkSearchIndexes(db),
  )
  for (const check of checks)
    print(
      `  ${check.index}: ${intact(check) ? 'ok' : `${check.missing} missing, ${check.extra} extra${check.error ? `, ${check.error}` : ''}`}`,
    )
  if (options.rebuildSearch || !checks.every(intact)) {
    timed(print, 'search indexes rebuilt from the catalog', () =>
      rebuildSearchIndexes(db),
    )
    const again = checkSearchIndexes(db)
    if (!again.every(intact)) {
      print('the rebuilt search indexes do not check out')
      return 1
    }
  }
  timed(print, 'search indexes merged', () => optimizeSearchIndexes(db))
  // What the merge freed, and on a database not vacuumed every free page,
  // back to the file system at once.
  timed(print, 'free pages released', () =>
    db.$client.exec('PRAGMA incremental_vacuum'),
  )
  // As the server's own `PRAGMA optimize` reads them, a few hundred rows
  // per index; every table, after the vacuum renewed them all.
  timed(print, 'statistics', () =>
    db.$client.exec('PRAGMA analysis_limit = 400; ANALYZE;'),
  )
  const problems = timed(print, 'integrity check', () => integrity(db))
  if (problems.length) {
    print(`integrity check failed:\n${problems.slice(0, 20).join('\n')}`)
    return 1
  }
  return 0
}

/**
 * Put the vacuumed copy in the database's place. The original, with its
 * WAL if one is left, goes to the backup directory, which keeps only it.
 * Returns where the original went.
 */
function swap(
  file: string,
  copy: string,
  backupDir: string | undefined,
  stamp: string,
): string {
  const dir = backupDir ?? path.join(path.dirname(file), 'backups', 'maintain')
  mkdirSync(dir, { recursive: true })
  const backup = path.join(dir, `midden-${stamp}.db`)
  renameSync(file, backup)
  try {
    renameSync(copy, file)
  } catch (error) {
    renameSync(backup, file)
    throw error
  }
  if (existsSync(`${file}-wal`)) renameSync(`${file}-wal`, `${backup}-wal`)
  rmSync(`${file}-shm`, { force: true })
  sync(file)
  for (const name of readdirSync(dir))
    if (OLD_BACKUP.test(name) && !name.startsWith(path.basename(backup)))
      rmSync(path.join(dir, name), { force: true })
  return backup
}
