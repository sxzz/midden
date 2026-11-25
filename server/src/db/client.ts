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
  client.exec('PRAGMA auto_vacuum = INCREMENTAL')
  client.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
  searchFunctions(client)
  const db = drizzle({ client })
  migrate(db, { migrationsFolder: MIGRATIONS })
  optimize(db, true)
  return db
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
