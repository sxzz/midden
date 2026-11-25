import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/node-sqlite'
import { migrate } from 'drizzle-orm/node-sqlite/migrator'

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
  client.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
  const db = drizzle({ client })
  migrate(db, { migrationsFolder: MIGRATIONS })
  optimize(db, true)
  return db
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
