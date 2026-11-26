import { Buffer } from 'node:buffer'
import { describe, expect, test } from 'vitest'
import { insertRow, migratedBefore, migrateRest } from '#testing/migrations.ts'
import { openDatabase, type Database } from './client.ts'

const columns = (db: Database, table: string) =>
  db.$client
    .prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid')
    .all(table)
    .map((row) => row.name)

const indexes = (db: Database, table: string) =>
  db.$client
    .prepare(
      `SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name`,
    )
    .all(table)
    .map((row) => row.name)

describe('raw_response_bodies', () => {
  test('a fresh database keeps bodies in their own table', () => {
    const db = openDatabase(':memory:')
    expect(columns(db, 'source_responses')).not.toContain('body')
    expect(columns(db, 'source_responses')).not.toContain('remote_at')
    expect(columns(db, 'source_response_bodies')).toEqual([
      'response_id',
      'body',
    ])
    expect(indexes(db, 'source_responses')).toEqual([
      'source_responses_position',
      'source_responses_sha256',
    ])
  })

  test('a database shaped like production keeps only the bodies still here', () => {
    const db = migratedBefore('raw_response_bodies')
    insertRow(db, 'collections', { id: 'c1' })
    insertRow(db, 'captures', { id: 'k1', collection_id: 'c1' })
    // Stored in the bucket: cleared, and moved past the others.
    const stored = Array.from({ length: 50 }, (_, i) => `s${i}`)
    for (const [i, id] of stored.entries())
      insertRow(db, 'source_responses', {
        id,
        capture_id: 'k1',
        position: i,
        body: Buffer.alloc(0),
        sha256: `sha-${id}`,
        size: 1000 + i,
        created_at: 1,
        remote_at: 2,
      })
    // Still here: one waiting for the upload, one found corrupt.
    for (const [i, id] of ['l1', 'l2'].entries())
      insertRow(db, 'source_responses', {
        id,
        capture_id: 'k1',
        position: 100 + i,
        body: Buffer.from(`body ${id}`),
        sha256: `sha-${id}`,
        size: 7,
        created_at: 1,
        remote_at: null,
      })
    insertRow(db, 'raw_upload_failures', {
      response_id: 'l2',
      failures: 1,
      retry_at: null,
      error: 'hash',
    })
    const before = db.$client
      .prepare('SELECT id, sha256, size FROM source_responses ORDER BY id')
      .all()

    migrateRest(db)

    expect(
      db.$client
        .prepare('SELECT id, sha256, size FROM source_responses ORDER BY id')
        .all(),
    ).toEqual(before)
    expect(
      db.$client
        .prepare(
          'SELECT response_id, CAST(body AS TEXT) AS body FROM source_response_bodies ORDER BY response_id',
        )
        .all(),
    ).toEqual([
      { response_id: 'l1', body: 'body l1' },
      { response_id: 'l2', body: 'body l2' },
    ])
    // Dropping the columns cascades nothing.
    expect(
      db.$client.prepare('SELECT response_id FROM raw_upload_failures').all(),
    ).toEqual([{ response_id: 'l2' }])
    expect(db.$client.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(db.$client.prepare('PRAGMA integrity_check').get()).toEqual({
      integrity_check: 'ok',
    })
  })
})
