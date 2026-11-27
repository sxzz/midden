import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { createApi } from '#http/app.ts'
import { SESSION_COOKIE, SESSION_TTL } from '#http/sessions.ts'
import { checkSearchIndexes, intact } from '#library/search-index.ts'
import { testContext } from '#testing/context.ts'
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

describe('catalog_id', () => {
  /** The collections an index finds for a query: by the rowid, before and after. */
  const find = (db: Database, index: string, query: string) =>
    db.$client
      .prepare(
        `SELECT k.collection_id AS id FROM ${index} f JOIN catalog k ON k.rowid = f.rowid
          WHERE ${index} MATCH ? ORDER BY 1`,
      )
      .all(query)
      .map((row) => row.id)

  test('a fresh database keys the catalog by an INTEGER PRIMARY KEY', () => {
    const db = openDatabase(':memory:')
    expect(
      db.$client
        .prepare(
          `SELECT name, type, pk FROM pragma_table_info('catalog') WHERE pk > 0`,
        )
        .all(),
    ).toEqual([{ name: 'id', type: 'INTEGER', pk: 1 }])
  })

  test('rows keep their rowids as ids, so the search indexes stay as they are', () => {
    const db = migratedBefore('catalog_id')
    const add = (id: string, text: string) => {
      insertRow(db, 'collections', { id, external_id: id })
      insertRow(db, 'catalog', { collection_id: id, search_text: text })
    }
    for (let i = 1; i <= 20; i++)
      add(
        `c${String(i).padStart(2, '0')}`,
        `post number ${i} ${i % 2 ? '猫咪' : '小狗'}`,
      )
    // Gaps, as deletions leave them.
    db.$client.exec(
      `DELETE FROM catalog WHERE collection_id IN ('c03', 'c06', 'c09', 'c12')`,
    )
    const keys = db.$client
      .prepare('SELECT rowid AS id, collection_id FROM catalog ORDER BY rowid')
      .all()
    const cats = find(db, 'catalog_cjk', '"猫咪"')
    const numbers = find(db, 'catalog_fts', '"number 1"')
    expect(cats).toHaveLength(8)

    migrateRest(db)

    expect(
      db.$client
        .prepare('SELECT id, collection_id FROM catalog ORDER BY id')
        .all(),
    ).toEqual(keys)
    expect(find(db, 'catalog_cjk', '"猫咪"')).toEqual(cats)
    expect(find(db, 'catalog_fts', '"number 1"')).toEqual(numbers)
    expect(checkSearchIndexes(db).every(intact)).toBe(true)

    // The triggers follow the new key.
    add('c21', 'brand new')
    expect(find(db, 'catalog_fts', '"brand new"')).toEqual(['c21'])
    db.$client.exec(
      `UPDATE catalog SET search_text = 'renamed' WHERE collection_id = 'c21'`,
    )
    expect(find(db, 'catalog_fts', '"brand new"')).toEqual([])
    expect(find(db, 'catalog_fts', '"renamed"')).toEqual(['c21'])
    db.$client.exec(`DELETE FROM catalog WHERE collection_id = 'c21'`)
    expect(find(db, 'catalog_fts', '"renamed"')).toEqual([])
    expect(checkSearchIndexes(db).every(intact)).toBe(true)
    expect(db.$client.prepare('PRAGMA integrity_check').get()).toEqual({
      integrity_check: 'ok',
    })
  })
})

describe('watches', () => {
  test('queued maintenance work moves to the rank below watch runs', () => {
    const db = migratedBefore('watches')
    const jobs: [string, number][] = [
      ['capture', 0],
      ['capture', 1],
      ['capture', 2],
      ['upload', 4],
      ['upload', 5],
      ['upload', 6],
    ]
    for (const [i, [type, priority]] of jobs.entries())
      insertRow(db, 'jobs', { id: i + 1, type, ref: `r${i}`, priority })
    insertRow(db, 'updates', { id: 'u1', collection_ids: '[]', options: '{}' })

    migrateRest(db)

    expect(
      db.$client
        .prepare('SELECT type, priority FROM jobs ORDER BY id')
        .all()
        .map((row) => [row.type, row.priority]),
    ).toEqual([
      ['capture', 0],
      ['capture', 1],
      ['capture', 3],
      // Only thumbnail renders had a priority of their own; they are gone.
      ['upload', 4],
      ['upload', 5],
      ['upload', 6],
    ])
    // Updates so far were all started by hand.
    expect(
      db.$client.prepare('SELECT origin, watch_id FROM updates').all(),
    ).toEqual([{ origin: 'manual', watch_id: null }])
    expect(db.$client.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })
})

describe('watch_intervals', () => {
  test('the fixed choices become a number and a unit, keeping their slots and runs', () => {
    const db = migratedBefore('watch_intervals')
    insertRow(db, 'folders', { id: 'f1', name: 'a', filter: '' })
    insertRow(db, 'folders', { id: 'f2', name: 'b', filter: '' })
    insertRow(db, 'folders', { id: 'f3', name: 'c', filter: '' })
    for (const [id, folder, frequency] of [
      ['w1', 'f1', '6h'],
      ['w2', 'f2', 'daily'],
      ['w3', 'f3', 'weekly'],
    ])
      insertRow(db, 'watches', {
        id,
        folder_id: folder,
        frequency,
        options: '{}',
        enabled: 1,
        next_run_at: 5000,
        error: '',
        created_at: 1234,
      })
    insertRow(db, 'updates', {
      id: 'u1',
      collection_ids: '[]',
      options: '{}',
      origin: 'watch',
      watch_id: 'w2',
    })

    migrateRest(db)

    expect(
      db.$client
        .prepare(
          'SELECT id, every_count, every_unit, time_zone, anchor_at, next_run_at FROM watches ORDER BY id',
        )
        .all(),
    ).toEqual(
      [
        ['w1', 6, 'hour'],
        ['w2', 1, 'day'],
        ['w3', 1, 'week'],
      ].map(([id, count, unit]) => ({
        id,
        every_count: count,
        every_unit: unit,
        time_zone: 'UTC',
        anchor_at: 1234,
        next_run_at: 5000,
      })),
    )
    expect(columns(db, 'watches')).not.toContain('frequency')
    // The run still names its watch.
    expect(db.$client.prepare('SELECT watch_id FROM updates').all()).toEqual([
      { watch_id: 'w2' },
    ])
    expect(indexes(db, 'watches')).toEqual([
      'watches_collection',
      'watches_due',
      'watches_folder',
    ])
    expect(db.$client.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })
})

describe('platform_thumbnails', () => {
  test('renders still queued and the pause of their type go', () => {
    const db = migratedBefore('platform_thumbnails')
    const jobs: [string, string][] = [
      ['thumbnail', 'blob-1'],
      ['download', 'asset-1'],
      ['thumbnail', 'blob-2'],
    ]
    for (const [i, [type, ref]] of jobs.entries())
      insertRow(db, 'jobs', { id: i + 1, type, ref, queue: 'download' })
    insertRow(db, 'settings', {
      key: 'jobs_control',
      value: JSON.stringify({
        paused: true,
        types: ['raw-upload', 'thumbnail'],
      }),
    })

    migrateRest(db)

    expect(
      db.$client.prepare('SELECT type, ref FROM jobs ORDER BY id').all(),
    ).toEqual([{ type: 'download', ref: 'asset-1' }])
    const control = db.$client
      .prepare(`SELECT value FROM settings WHERE key = 'jobs_control'`)
      .get()!
    expect(JSON.parse(String(control.value))).toEqual({
      paused: true,
      types: ['raw-upload'],
    })
    expect(columns(db, 'assets')).toEqual(
      expect.arrayContaining(['width', 'height', 'thumbnail_url']),
    )
  })
})

describe('web_session_devices', () => {
  test('sessions stay signed in: an id, used and made now, their expiry kept', async () => {
    const db = migratedBefore('web_session_devices')
    const digest = (value: string) =>
      createHash('sha256').update(value).digest('hex')
    const soon = Date.now() + 6 * 3_600_000
    insertRow(db, 'web_sessions', { digest: digest('a'), expires_at: soon })
    insertRow(db, 'web_sessions', {
      digest: digest('b'),
      expires_at: soon + 1,
    })
    const before = Date.now()

    migrateRest(db)

    const rows = db.$client
      .prepare('SELECT * FROM web_sessions ORDER BY expires_at')
      .all()
    expect(rows).toEqual([
      expect.objectContaining({ digest: digest('a'), expires_at: soon }),
      expect.objectContaining({ digest: digest('b'), expires_at: soon + 1 }),
    ])
    for (const row of rows) {
      expect(row.id).toMatch(/^[\da-f]{32}$/)
      expect(row.created_at).toBe(row.last_used_at)
      expect(Number(row.created_at)).toBeGreaterThanOrEqual(before - 1000)
      expect(Number(row.created_at)).toBeLessThanOrEqual(Date.now())
      expect([row.method, row.origin, row.device]).toEqual([null, null, null])
    }
    expect(rows[0]!.id).not.toBe(rows[1]!.id)
    expect(indexes(db, 'web_sessions')).toEqual(['web_sessions_expires'])

    // Their next request renews them, to a full 30 days.
    const ctx = { ...testContext(), db }
    const response = await createApi({ ctx }).request('/session', {
      headers: { Cookie: `${SESSION_COOKIE}=a` },
    })
    expect(response.status).toBe(204)
    expect(response.headers.get('set-cookie')).toContain(
      `Max-Age=${SESSION_TTL}`,
    )
    const renewed = db.$client
      .prepare('SELECT expires_at FROM web_sessions WHERE digest = ?')
      .get(digest('a'))!
    expect(Number(renewed.expires_at)).toBeGreaterThan(
      Date.now() + SESSION_TTL * 1000 - 60_000,
    )
    await ctx.queue.stop()
  })
})
