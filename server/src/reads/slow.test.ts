import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { openDatabase } from '#db/client.ts'
import { QueryPool } from './pool.ts'
import { KEEP, listSlowQueries, SlowQueryLog } from './slow-log.ts'
import {
  describeQuery,
  inScope,
  watchStatements,
  type SlowQuery,
} from './slow.ts'

const SLOW = new URL('../testing/slow-thread.ts', import.meta.url)

let pool: QueryPool | undefined
afterEach(async () => {
  await pool?.close()
  pool = undefined
})

const query = (n: number): SlowQuery => ({
  at: 1_800_000_000_000 + n,
  route: 'GET /v1/collections',
  query: `q=${n}`,
  sql: 'SELECT 1',
  params: '[]',
  ms: 300 + n,
  rows: n,
})

describe('slow queries', () => {
  test('a statement over the threshold is reported with what asked for it', () => {
    const db = new DatabaseSync(':memory:')
    const seen: SlowQuery[] = []
    watchStatements(db, (q) => seen.push(q), 0)
    db.exec('CREATE TABLE t (x)')
    inScope('GET /agent/v1/posts', 'q=cat', () => {
      describeQuery('{"q":"cat"}')
      db.prepare('INSERT INTO t VALUES (?), (?)').run(1, 2n)
      db.prepare('SELECT x FROM t WHERE x > ?').all(0)
    })
    expect(seen).toEqual([
      expect.objectContaining({
        route: 'GET /agent/v1/posts',
        query: '{"q":"cat"}',
        sql: 'INSERT INTO t VALUES (?), (?)',
        params: '[1,"2"]',
        rows: 2,
      }),
      expect.objectContaining({
        sql: 'SELECT x FROM t WHERE x > ?',
        params: '[0]',
        rows: 2,
      }),
    ])
    // Under the threshold: nothing.
    const quiet: SlowQuery[] = []
    const other = new DatabaseSync(':memory:')
    watchStatements(other, (q) => quiet.push(q))
    other.prepare('SELECT 1').get()
    expect(quiet).toEqual([])
  })

  test('a read thread’s slow statement reaches the web process', async () => {
    const seen: SlowQuery[] = []
    pool = new QueryPool({
      script: SLOW,
      workerData: null,
      onSlow: (q) => seen.push(q),
    })
    await pool.run('web', 'slow', { ms: 50 })
    expect(seen).toEqual([])
    await pool.run('web', 'slow', { ms: 350 })
    expect(seen).toEqual([
      expect.objectContaining({
        route: 'GET /slow',
        query: 'ms=350',
        sql: expect.stringContaining('WITH RECURSIVE'),
        rows: 1,
      }),
    ])
    expect(seen[0]!.ms).toBeGreaterThanOrEqual(300)
  })

  test('kept in the table, the newest few hundred, and logged', () => {
    const db = openDatabase(':memory:')
    const warn = vi.fn()
    const log = new SlowQueryLog({
      db,
      logger: { warn } as never,
      busyTimeoutMs: 2000,
    })
    for (let i = 0; i < 3; i++) log.record(query(i))
    log.flush()
    expect(listSlowQueries(db).map((q) => q.query)).toEqual([
      'q=2',
      'q=1',
      'q=0',
    ])
    // One line, the others counted in the next.
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]![0]).toMatchObject({
      route: 'GET /v1/collections',
      ms: 300,
    })
    for (let i = 3; i < KEEP + 50; i++) {
      log.record(query(i))
      if (i % 50 === 0) log.flush()
    }
    log.stop()
    const kept = db.$client
      .prepare('SELECT count(*) AS n, min(rows) AS oldest FROM slow_queries')
      .get() as { n: number; oldest: number }
    expect(kept).toEqual({ n: KEEP, oldest: 50 })
    expect(listSlowQueries(db, 1)[0]).toEqual({
      id: expect.any(Number),
      at: new Date(1_800_000_000_000 + KEEP + 49).toISOString(),
      route: 'GET /v1/collections',
      query: `q=${KEEP + 49}`,
      sql: 'SELECT 1',
      params: '[]',
      ms: 300 + KEEP + 49,
      rows: KEEP + 49,
    })
  })

  test('another writer holding the lock: kept for later, not waited for', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'slow-')), 'db')
    const db = openDatabase(file)
    const other = new DatabaseSync(file)
    const log = new SlowQueryLog({
      db,
      logger: { warn: () => {} } as never,
      busyTimeoutMs: 2000,
    })
    log.record(query(1))
    other.exec('BEGIN IMMEDIATE')
    const started = Date.now()
    log.flush()
    expect(Date.now() - started).toBeLessThan(500)
    other.exec('COMMIT')
    expect(listSlowQueries(db)).toEqual([])
    log.flush()
    expect(listSlowQueries(db)).toHaveLength(1)
    log.stop()
    other.close()
  })
})
