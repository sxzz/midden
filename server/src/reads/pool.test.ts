import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { backup, DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import { AgentError } from '#agent/errors.ts'
import { inlineReads, pooledReads } from '#agent/runner.ts'
import { agentFixture, type AgentFixture } from '#testing/agent.ts'
import { SYSTEM } from '#users/principal.ts'
import { PoolError, QueryPool, READ_THREAD } from './pool.ts'
import type { SlowQuery } from './slow.ts'
import type { ReadThreadData } from './thread.ts'

const SLOW = new URL('../testing/slow-thread.ts', import.meta.url)

let pool: QueryPool | undefined
let fixture: AgentFixture | undefined
afterEach(async () => {
  await pool?.close()
  pool = undefined
  await fixture?.ctx.queue.stop()
  fixture = undefined
})

/** The longest the event loop went without running a timer while `work` ran. */
async function longestStall(work: () => Promise<unknown>): Promise<number> {
  let last = performance.now()
  let longest = 0
  const timer = setInterval(() => {
    const now = performance.now()
    longest = Math.max(longest, now - last)
    last = now
  }, 5)
  try {
    await work()
  } finally {
    clearInterval(timer)
  }
  return Math.max(longest, performance.now() - last)
}

describe('read threads', () => {
  test('a slow query runs on its own thread; the event loop keeps going', async () => {
    pool = new QueryPool({ script: SLOW, workerData: null })
    // Started, so the measure is the query's alone.
    await pool.run('web', 'echo', 1)
    const started = performance.now()
    const stall = await longestStall(() =>
      pool!.run('web', 'slow', { ms: 800 }),
    )
    expect(performance.now() - started).toBeGreaterThanOrEqual(790)
    expect(stall).toBeLessThan(100)

    // The same query on this thread holds it up for all of it.
    const db = new DatabaseSync(':memory:')
    db.function('now_ms', { deterministic: false }, () => Date.now())
    const inline = await longestStall(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      db.prepare(
        `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c
        WHERE x % 10000 != 0 OR now_ms() < ?) SELECT count(*) FROM c`,
      ).get(Date.now() + 800)
    })
    expect(inline).toBeGreaterThanOrEqual(790)
  })

  test('reads run at once, one on each thread', async () => {
    pool = new QueryPool({ script: SLOW, workerData: null })
    pool.warm(3)
    await Promise.all([1, 2, 3].map(() => pool!.run('web', 'echo', 0)))
    const started = performance.now()
    await Promise.all([
      pool.run('web', 'slow', { ms: 400 }),
      pool.run('web', 'slow', { ms: 400 }),
      pool.run('agent', 'slow', { ms: 400 }),
    ])
    expect(performance.now() - started).toBeLessThan(750)
    expect(pool.threads).toEqual({ live: 3, retiring: 0 })
  })

  test('the agent lane holds at most its share; the web app’s reads go first', async () => {
    pool = new QueryPool({ script: SLOW, workerData: null, size: 3 })
    pool.warm()
    await Promise.all([1, 2, 3].map(() => pool!.run('web', 'echo', 0)))
    const ended: string[] = []
    const run = (lane: 'web' | 'agent', name: string, ms: number) =>
      pool!.run(lane, 'slow', { ms }).then(() => ended.push(name))
    const started = performance.now()
    // Two agent reads hold two threads; a third waits though one is free.
    const agents = [run('agent', 'a1', 300), run('agent', 'a2', 300)]
    const third = run('agent', 'a3', 50)
    // The free thread is the web app's at once.
    await run('web', 'w1', 50)
    expect(performance.now() - started).toBeLessThan(250)
    expect(ended).toEqual(['w1'])
    await Promise.all([...agents, third])
    // It ran only once one of the two had ended.
    expect(ended.indexOf('a3')).toBeGreaterThan(
      Math.min(ended.indexOf('a1'), ended.indexOf('a2')),
    )
  })

  test('past its timeout a read fails; a new thread takes over', async () => {
    pool = new QueryPool({
      script: SLOW,
      workerData: null,
      lanes: { agent: { timeoutMs: 200 } },
    })
    await pool.run('agent', 'echo', 1)
    const started = performance.now()
    const error = await pool
      .run('agent', 'slow', { ms: 1500 })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PoolError)
    expect(error).toMatchObject({ code: 'timeout' })
    expect(performance.now() - started).toBeLessThan(700)
    // The old thread ends when SQLite gives it back; meanwhile another reads.
    expect(pool.threads.retiring).toBe(1)
    expect(await pool.run('agent', 'echo', 'still here')).toBe('still here')
    await expect.poll(() => pool!.threads.retiring, { timeout: 5000 }).toBe(0)
  })

  test('the agent API answers query_timeout, and internal for the unexpected', async () => {
    pool = new QueryPool({
      script: SLOW,
      workerData: null,
      lanes: { agent: { timeoutMs: 200 } },
    })
    const reads = pooledReads(pool)
    const run = (op: string, input: unknown) =>
      reads.run(SYSTEM, op as never, input as never).catch((e: unknown) => e)
    const timedOut = await run('slow', { ms: 1000 })
    expect(timedOut).toBeInstanceOf(AgentError)
    expect(timedOut).toMatchObject({ code: 'query_timeout' })
    expect(await run('nonsense', {})).toMatchObject({ code: 'internal' })
  })

  test('the real read thread answers exactly as reads in place do', async () => {
    fixture = await agentFixture()
    const file = path.join(
      mkdtempSync(path.join(tmpdir(), 'midden-agent-')),
      'db',
    )
    await backup(fixture.ctx.db.$client, file)
    const slow: SlowQuery[] = []
    pool = new QueryPool({
      script: READ_THREAD,
      workerData: {
        databasePath: file,
        mediaDir: path.join(tmpdir(), 'unused'),
        // The test context signs media with this key.
        mediaKey: new TextEncoder().encode('test'),
        types: fixture.reader.types,
        countPointers: fixture.ctx.platforms.countPointers(),
        // Every statement counts as slow here.
        slowQueryMs: 0,
      } satisfies ReadThreadData,
      onSlow: (query) => slow.push(query),
    })
    const pooled = pooledReads(pool)
    const inline = inlineReads(fixture.reader)
    const input = {
      kind: 'posts' as const,
      params: { q: ['cat'], view: ['full'] },
      origin: 'https://midden.test',
    }
    const answer = await pooled.run(SYSTEM, 'search', input)
    expect(answer.items.length).toBe(2)
    expect(answer).toEqual(await inline.run(SYSTEM, 'search', input))
    // Its statements are timed and reported with the request they ran for,
    // named by its canonical query.
    expect(slow.length).toBeGreaterThan(0)
    expect(slow[0]).toMatchObject({
      route: 'GET /agent/v1/posts',
      query: expect.stringContaining('"q":"cat"'),
      sql: expect.any(String),
      ms: expect.any(Number),
    })
    const missing = await pooled
      .run(SYSTEM, 'context', { id: fixture.ids['7']!, origin: '' })
      .catch((e: unknown) => e)
    expect(missing).toMatchObject({ code: 'not_found' })
    // Its connection only reads.
    expect(await pooled.run(SYSTEM, 'folders', undefined)).toEqual({
      items: [],
    })
    // A folder the web process just wrote is counted there.
    expect(
      await pool.run('web', 'folderCounts', {
        principal: SYSTEM,
        input: { id: 'none' },
      }),
    ).toBeNull()
  }, 30_000)
})
