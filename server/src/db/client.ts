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
  // WAL lets readers proceed while the single writer commits.
  client.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
  const db = drizzle({ client })
  migrate(db, { migrationsFolder: MIGRATIONS })
  return db
}

export type Database = ReturnType<typeof openDatabase>
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
/** Anything queries can run on: the database itself or an open transaction. */
export type Executor = Database | Transaction
