import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/node-sqlite'
import { migrate } from 'drizzle-orm/node-sqlite/migrator'
import { cjkWords, fold, searchName } from '#library/search-text.ts'

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url))

/** Open (creating if needed) the database and apply pending migrations. */
export function openDatabase(file: string) {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true })
  const client = new DatabaseSync(file, {
    enableForeignKeyConstraints: true,
    // Restored to this after the opening optimize below.
    timeout: 5000,
  })
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
  searchFunctions(client)
  const db = drizzle({ client })
  migrate(db, { migrationsFolder: MIGRATIONS })
  // Fresh statistics can wait for the next run (every 6 hours) rather than
  // hold up a start while another writer has the lock.
  client.exec('PRAGMA busy_timeout = 0')
  try {
    optimize(db, true)
  } catch (error) {
    if (!isBusy(error)) throw error
  } finally {
    client.exec('PRAGMA busy_timeout = 5000')
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

export type Database = ReturnType<typeof openDatabase>
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
/** Anything queries can run on: the database itself or an open transaction. */
export type Executor = Database | Transaction
