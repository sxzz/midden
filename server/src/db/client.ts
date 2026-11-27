import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { sql } from 'drizzle-orm'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { drizzle } from 'drizzle-orm/node-sqlite'
import { migrate } from 'drizzle-orm/node-sqlite/migrator'
import { cjkWords, fold, searchName } from '#library/search-text.ts'
import { filterToQuery } from '#query/convert.ts'
import { WriteStats } from './writes.ts'

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url))
const MIGRATIONS_TABLE = '__drizzle_migrations'

export interface OpenOptions {
  /**
   * How long a statement waits for the write lock before failing with
   * `database is locked`. node:sqlite waits synchronously, freezing the
   * process meanwhile, so the web process keeps it short.
   */
  busyTimeoutMs?: number
  /**
   * Apply pending migrations. Only one process may: two would both see a
   * migration pending and apply it twice. The others wait for it
   * (`waitForMigrations`).
   */
  migrate?: boolean
  /**
   * Run SQLite's automatic PASSIVE checkpoints from this connection, after
   * its commits. The web process leaves them to the worker and Litestream,
   * so a request never copies WAL pages into the database.
   */
  autoCheckpoint?: boolean
  /**
   * Hold the database alone until closed, or fail at once with
   * `database is locked` while any other connection has it open (an idle
   * one too): for offline maintenance, which must not run beside the app.
   */
  exclusive?: boolean
  /**
   * Only read, as the read threads do: the file must exist and be migrated;
   * nothing is set up, and the file is opened read-only, so any write to the
   * database fails. Temporary tables (the connection's own scratch space,
   * which some reads collect ids in) still work: `query_only` would refuse
   * them too.
   */
  readOnly?: boolean
}

/** Open (creating if needed) the database and apply pending migrations. */
export function openDatabase(file: string, options: OpenOptions = {}) {
  const busyTimeout = options.busyTimeoutMs ?? 5000
  if (options.readOnly) {
    const client = new DatabaseSync(file, {
      readOnly: true,
      timeout: busyTimeout,
    })
    searchFunctions(client)
    return immediateWrites(drizzle({ client }))
  }
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true })
  const client = new DatabaseSync(file, {
    enableForeignKeyConstraints: true,
    // Restored to this after the opening optimize below.
    timeout: options.exclusive ? 0 : busyTimeout,
  })
  if (options.exclusive) {
    // The first write takes an exclusive lock on the file and keeps it.
    // Every other connection holds a shared lock on it for as long as it is
    // open, in WAL mode too, so this fails while one is.
    client.exec('PRAGMA locking_mode = EXCLUSIVE')
    client.exec('BEGIN IMMEDIATE; COMMIT')
  }
  // WAL lets readers proceed while the single writer commits. Litestream
  // (litestream.yml) may replicate the file from its WAL, holding a read
  // transaction so that only its own checkpoints restart the WAL. SQLite's
  // automatic checkpoints are PASSIVE and cannot, so they stay on. Explicit
  // RESTART or TRUNCATE checkpoints would make it upload the whole database
  // again, and VACUUM rewrites every page into the WAL: don't add them.
  // Pages freed by deletions can then go back to the file system a few at a
  // time (`incremental_vacuum` in maintenance). It only takes on a new
  // database; an existing one keeps its mode until a VACUUM.
  // Both are set only where they change something: setting them takes the
  // write lock, which a checkpoint or another writer may hold for a while,
  // and a start must not fail on that.
  if (pragma(client, 'page_count') === 0)
    client.exec('PRAGMA auto_vacuum = INCREMENTAL')
  if (pragma(client, 'journal_mode') !== 'wal')
    client.exec('PRAGMA journal_mode = WAL')
  client.exec('PRAGMA synchronous = NORMAL')
  if (options.autoCheckpoint === false)
    client.exec('PRAGMA wal_autocheckpoint = 0')
  searchFunctions(client)
  const db = immediateWrites(drizzle({ client }))
  if (options.migrate !== false) migrate(db, { migrationsFolder: MIGRATIONS })
  // Maintenance writes its statistics itself, when it writes at all.
  if (options.exclusive) return db
  // Fresh statistics can wait for the next run (every 6 hours) rather than
  // hold up a start while another writer has the lock.
  client.exec('PRAGMA busy_timeout = 0')
  try {
    optimize(db, true)
  } catch (error) {
    if (!isBusy(error)) throw error
  } finally {
    // PRAGMA takes no bound parameters; this is a number from the caller.
    // eslint-disable-next-line unicorn/no-unsafe-sqlite-interpolation
    client.exec(`PRAGMA busy_timeout = ${Math.trunc(busyTimeout)}`)
  }
  return db
}

function pragma(client: DatabaseSync, name: string): unknown {
  return client.prepare(`PRAGMA ${name}`).get()?.[name]
}

/**
 * SQLite could not get a lock in time (SQLITE_BUSY or SQLITE_LOCKED, with
 * their extended codes): another writer or a checkpoint held it. Waiting
 * and trying again is the fix.
 */
export function isBusy(error: unknown): boolean {
  // Drizzle wraps the driver's error as the cause of its own.
  for (let e = error; e instanceof Error; e = e.cause) {
    const code = (e as { errcode?: unknown }).errcode
    if (typeof code === 'number' && [5, 6].includes(code & 0xff)) return true
  }
  return false
}

/**
 * Every transaction begins IMMEDIATE unless it asks otherwise: it takes the
 * write lock up front, waiting for it with the busy timeout. A DEFERRED one
 * reads first and asks for the lock at its first write; if another process
 * committed in between, SQLite fails it at once (SQLITE_BUSY_SNAPSHOT,
 * without waiting), and with two processes writing that happens. Read-only
 * transactions pass `{ behavior: 'deferred' }`. The time spent waiting for
 * the lock and holding it is counted in `$writes`.
 */
function immediateWrites<
  D extends { transaction: (...args: never[]) => unknown },
>(db: D): D & { $writes: WriteStats } {
  const writes = new WriteStats()
  const begin = db.transaction.bind(db) as (
    fn: (tx: unknown) => unknown,
    config?: { behavior?: string },
  ) => unknown
  const transaction = (
    fn: (tx: unknown) => unknown,
    config?: { behavior?: string },
  ) => {
    const behavior = config?.behavior ?? 'immediate'
    if (behavior === 'deferred') return begin(fn, config)
    const asked = performance.now()
    let locked = asked
    try {
      return begin(
        (tx) => {
          locked = performance.now()
          return fn(tx)
        },
        { ...config, behavior },
      )
    } finally {
      writes.record(locked - asked, performance.now() - locked)
    }
  }
  return Object.assign(db, {
    transaction: transaction as unknown as D['transaction'],
    $writes: writes,
  })
}

const text = (value: unknown) => (typeof value === 'string' ? value : '')

/**
 * The search folding (`library/search-text.ts`) as SQL functions: the
 * catalog computes its search columns with them, and the trigger that keeps
 * `catalog_cjk` in step calls one, so they are there before migrations run.
 * A connection without them (the sqlite3 shell) cannot write those columns.
 */
function searchFunctions(client: DatabaseSync): void {
  const options = { deterministic: true, directOnly: false }
  client.function('search_fold', options, (value) => fold(text(value)))
  client.function('search_names', options, (name, handle) =>
    searchName(text(name), text(handle)),
  )
  client.function('search_words', options, (value) => cjkWords(text(value)))
  // A folder's old filter as a query (migration `folder_queries`).
  client.function('folder_query', options, (value) =>
    JSON.stringify(filterToQuery(text(value))),
  )
}

/**
 * Refresh the query planner's statistics where they are missing or stale,
 * reading at most a few hundred rows per index. SQLite recommends this on
 * opening a long-lived connection and then every few hours.
 */
export function optimize(db: Database, opening = false): void {
  db.$client.exec(
    `PRAGMA analysis_limit = 400; PRAGMA optimize${opening ? ' = 0x10002' : ''};`,
  )
}

interface AppliedMigration {
  name: string | null
  hash: string
}

function applied(db: Database): AppliedMigration[] {
  const table = db.get<{ n: number }>(
    sql`SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = ${MIGRATIONS_TABLE}`,
  )
  if (!table?.n) return []
  return db.all<AppliedMigration>(
    sql`SELECT name, hash FROM ${sql.identifier(MIGRATIONS_TABLE)}`,
  )
}

/** The newest migration the database has applied; names start with a timestamp. */
export function latestMigration(db: Database): string | undefined {
  return applied(db)
    .map((row) => row.name)
    .filter((name): name is string => !!name)
    .toSorted()
    .at(-1)
}

/** Migrations this version has that the database does not yet. */
export function pendingMigrations(db: Database): number {
  const rows = applied(db)
  const known = new Set(rows.flatMap((row) => [row.name, row.hash]))
  return readMigrationFiles({ migrationsFolder: MIGRATIONS }).filter(
    (migration) => !known.has(migration.name) && !known.has(migration.hash),
  ).length
}

/**
 * Migrations this version does not know: a newer version migrated the
 * database, and this one must not write to it any more.
 */
export function unknownMigrations(db: Database): number {
  const local = new Set(
    readMigrationFiles({ migrationsFolder: MIGRATIONS }).flatMap((m) => [
      m.name,
      m.hash,
    ]),
  )
  return applied(db).filter(
    (row) => (!row.name || !local.has(row.name)) && !local.has(row.hash),
  ).length
}

/**
 * Wait until another process (the web process) has applied every migration
 * this version has. Resolves at once when none is pending.
 */
export async function waitForMigrations(
  db: Database,
  options: {
    signal?: AbortSignal
    intervalMs?: number
    onWait?: (pending: number) => void
  } = {},
): Promise<void> {
  for (let first = true; ; first = false) {
    const pending = pendingMigrations(db)
    if (!pending) return
    if (first) options.onWait?.(pending)
    await sleep(options.intervalMs ?? 1000, undefined, {
      signal: options.signal,
    })
  }
}

export type Database = ReturnType<typeof openDatabase>
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
/** Anything queries can run on: the database itself or an open transaction. */
export type Executor = Database | Transaction
