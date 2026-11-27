import { cpSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/node-sqlite/migrator'
import { openDatabase, type Database } from '#db/client.ts'

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url))
const INTEGER = /INT/i

/** A folder of the migrations up to the one named `before`, without it. */
function migrationsBefore(before: string): string {
  const all = readdirSync(MIGRATIONS).toSorted()
  const index = all.findIndex((name) => name.endsWith(`_${before}`))
  if (index === -1) throw new Error(`no migration ${before}`)
  const dir = mkdtempSync(path.join(tmpdir(), 'midden-migrations-'))
  for (const name of all.slice(0, index))
    cpSync(path.join(MIGRATIONS, name), path.join(dir, name), {
      recursive: true,
    })
  return dir
}

/**
 * A database with the migrations up to the one named `before`, without it:
 * the schema a deployed database had before it, to fill with rows of that
 * shape. `migrateRest` applies the others.
 */
export function migratedBefore(before: string, file = ':memory:'): Database {
  const db = openDatabase(file, { migrate: false })
  migrate(db, { migrationsFolder: migrationsBefore(before) })
  return db
}

/** The other migrations; with `before`, only those up to that one. */
export function migrateRest(db: Database, before?: string): void {
  migrate(db, {
    migrationsFolder: before ? migrationsBefore(before) : MIGRATIONS,
  })
}

interface Column {
  name: string
  type: string
  notnull: number
  dflt_value: unknown
  pk: number
  hidden: number
}

/**
 * Insert a row, filling the NOT NULL columns without a default that
 * `values` leaves out with '' or 0: tests of a migration name only the
 * columns it reads.
 */
export function insertRow(
  db: Database,
  table: string,
  values: Record<string, unknown>,
): void {
  const columns = db.$client
    .prepare(`SELECT * FROM pragma_table_xinfo(?)`)
    .all(table) as unknown as Column[]
  const row: Record<string, unknown> = {}
  for (const column of columns) {
    if (column.hidden) continue
    if (column.name in values) row[column.name] = values[column.name]
    else if (column.notnull && column.dflt_value === null)
      row[column.name] = INTEGER.test(column.type) ? 0 : ''
  }
  const names = Object.keys(row)
  db.$client
    .prepare(
      `INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
    )
    .run(...(Object.values(row) as never[]))
}
