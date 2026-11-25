import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { catalogMissing } from '#library/catalog.ts'
import {
  isBusy,
  openDatabase,
  pendingMigrations,
  unknownMigrations,
  waitForMigrations,
} from './client.ts'
import { settings } from './schema.ts'

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'midden-db-'))
  file = path.join(dir, 'midden.db')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('an existing database opens while another connection holds the write lock', () => {
  openDatabase(file).$client.close()

  // As Litestream's forced TRUNCATE checkpoint does, or a long write.
  const writer = new DatabaseSync(file)
  writer.exec('BEGIN IMMEDIATE')
  try {
    const started = Date.now()
    const db = openDatabase(file)
    expect(catalogMissing(db)).toBe(0)
    // Well under the 5 s busy timeout: nothing waited for the lock.
    expect(Date.now() - started).toBeLessThan(2000)
    expect(db.$client.prepare('PRAGMA journal_mode').get()).toEqual({
      journal_mode: 'wal',
    })
    expect(db.$client.prepare('PRAGMA auto_vacuum').get()).toEqual({
      auto_vacuum: 2,
    })
    db.$client.close()
  } finally {
    writer.exec('ROLLBACK')
    writer.close()
  }
})

test('a lock held too long is recognised as busy', () => {
  const db = openDatabase(file)
  const writer = new DatabaseSync(file)
  writer.exec('BEGIN IMMEDIATE')
  try {
    db.$client.exec('PRAGMA busy_timeout = 0')
    let error: unknown
    try {
      db.$client.exec('CREATE TABLE t (x)')
    } catch (error_) {
      error = error_
    }
    expect(isBusy(error)).toBe(true)
    expect(isBusy(new Error('other'))).toBe(false)
  } finally {
    writer.exec('ROLLBACK')
    writer.close()
    db.$client.close()
  }
})

describe('two processes', () => {
  test('a transaction takes the write lock before it reads', () => {
    const a = openDatabase(file)
    const b = openDatabase(file, { busyTimeoutMs: 0 })
    a.transaction((tx) => {
      tx.select().from(settings).all()
      // B cannot write in between, so A's own write never meets a newer
      // snapshot (SQLITE_BUSY_SNAPSHOT, which no busy timeout waits out).
      let error: unknown
      try {
        b.insert(settings).values({ key: 'b', value: '1' }).run()
      } catch (thrown) {
        error = thrown
      }
      // The web process answers it with a 503 to try again.
      expect(isBusy(error)).toBe(true)
      // Reading goes on.
      expect(b.select().from(settings).all()).toEqual([])
      tx.insert(settings).values({ key: 'a', value: '1' }).run()
    })
    expect(b.select().from(settings).all()).toEqual([{ key: 'a', value: '1' }])
    expect(a.$writes.take()).toMatchObject({ count: 1 })
    expect(a.$writes.take()).toMatchObject({ count: 0 })
    a.$client.close()
    b.$client.close()
  })

  test('a read-only transaction can stay deferred', () => {
    const a = openDatabase(file)
    const b = openDatabase(file, { busyTimeoutMs: 0 })
    a.transaction(
      (tx) => {
        tx.select().from(settings).all()
        b.insert(settings).values({ key: 'b', value: '1' }).run()
      },
      { behavior: 'deferred' },
    )
    expect(a.$writes.take().count).toBe(0)
    a.$client.close()
    b.$client.close()
  })

  test('the worker waits for the web process to migrate', async () => {
    const worker = openDatabase(file, { migrate: false })
    expect(pendingMigrations(worker)).toBeGreaterThan(0)
    let migrated = false
    const waiting = waitForMigrations(worker, { intervalMs: 5 }).then(
      () => (migrated = true),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(migrated).toBe(false)
    const web = openDatabase(file)
    await waiting
    expect(pendingMigrations(worker)).toBe(0)
    expect(unknownMigrations(worker)).toBe(0)
    // A newer version's migration, which this one does not know.
    web.run(
      sql`INSERT INTO __drizzle_migrations (hash, created_at, name) VALUES ('later', 0, '29991231000000_later')`,
    )
    expect(unknownMigrations(worker)).toBe(1)
    worker.$client.close()
    web.$client.close()
  })
})
