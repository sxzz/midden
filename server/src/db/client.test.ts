import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { catalogMissing } from '#library/catalog.ts'
import { isBusy, openDatabase } from './client.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'midden-db-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('an existing database opens while another connection holds the write lock', () => {
  const file = path.join(dir, 'midden.db')
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
  const file = path.join(dir, 'midden.db')
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
