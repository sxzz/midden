import { sql, type SQL, type SQLWrapper } from 'drizzle-orm'

/**
 * `column IN (values)` with the values bound as one JSON array: binding them
 * one by one fails past SQLite's limit of 32766 bound values.
 */
export const inJson = (column: SQLWrapper, values: readonly unknown[]): SQL =>
  sql`${column} IN (SELECT value FROM json_each(${JSON.stringify(values)}))`
