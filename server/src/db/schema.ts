import {
  index,
  integer,
  sqliteTableCreator,
  text,
} from 'drizzle-orm/sqlite-core'

// Columns are declared in camelCase and stored in snake_case.
const sqliteTable = sqliteTableCreator((name) => name, 'snake_case')

/**
 * Durable background work. A row exists only while the job is pending or
 * running; finished jobs are deleted, and their outcome lives on the records
 * they worked on.
 */
export const jobs = sqliteTable(
  'jobs',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    type: text().notNull(),
    // The record the job works on, interpreted by the job type's handler.
    ref: text().notNull(),
    queue: text().notNull(),
    // Lower runs first within a queue.
    priority: integer().notNull().default(0),
    state: text({ enum: ['available', 'running'] })
      .notNull()
      .default('available'),
    attempt: integer().notNull().default(0),
    maxAttempts: integer().notNull(),
    runAt: integer({ mode: 'timestamp_ms' }).notNull(),
    leaseUntil: integer({ mode: 'timestamp_ms' }),
    lastError: text().notNull().default(''),
    createdAt: integer({ mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('jobs_claim').on(t.queue, t.state, t.priority, t.runAt)],
)
