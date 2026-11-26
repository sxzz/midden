import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { backup, DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import { agentFixture, type AgentFixture } from '#testing/agent.ts'
import { AgentError } from './errors.ts'
import { Gate } from './gate.ts'
import { QueryPool, READ_THREAD } from './pool.ts'
import { inlineReads, pooledReads, type Reads } from './runner.ts'
import type { ReadThreadData } from './worker.ts'

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
    await pool.run('echo', 1)
    const started = performance.now()
    const stall = await longestStall(() => pool!.run('slow', { ms: 800 }))
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

  test('two reads run at once, one on each thread', async () => {
    pool = new QueryPool({ script: SLOW, workerData: null })
    const started = performance.now()
    await Promise.all([
      pool.run('slow', { ms: 400 }),
      pool.run('slow', { ms: 400 }),
    ])
    expect(performance.now() - started).toBeLessThan(750)
    expect(pool.threads).toEqual({ live: 2, retiring: 0 })
  })

  test('past its timeout a read answers query_timeout; a new thread takes over', async () => {
    pool = new QueryPool({ script: SLOW, workerData: null, timeoutMs: 200 })
    await pool.run('echo', 1)
    const started = performance.now()
    await expect(pool.run('slow', { ms: 1500 })).rejects.toMatchObject({
      code: 'query_timeout',
    })
    expect(performance.now() - started).toBeLessThan(700)
    // The old thread ends when SQLite gives it back; meanwhile another reads.
    expect(pool.threads.retiring).toBe(1)
    expect(await pool.run('echo', 'still here')).toBe('still here')
    await expect.poll(() => pool!.threads.retiring, { timeout: 5000 }).toBe(0)
  })

  test('a read that throws answers the API’s error', async () => {
    pool = new QueryPool({ script: SLOW, workerData: null })
    const error = await pool.run('nonsense', {}).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AgentError)
    expect(error).toMatchObject({ code: 'internal' })
  })

  test('the real read thread answers exactly as reads in place do', async () => {
    fixture = await agentFixture()
    const file = path.join(
      mkdtempSync(path.join(tmpdir(), 'midden-agent-')),
      'db',
    )
    await backup(fixture.ctx.db.$client, file)
    pool = new QueryPool({
      script: READ_THREAD,
      workerData: {
        databasePath: file,
        mediaDir: path.join(tmpdir(), 'unused'),
        // The test context signs media with this key.
        mediaKey: new TextEncoder().encode('test'),
        types: fixture.reader.types,
      } satisfies ReadThreadData,
    })
    const pooled = pooledReads(pool)
    const inline = inlineReads(fixture.reader)
    const input = {
      kind: 'posts' as const,
      params: { q: ['cat'], view: ['full'] },
      origin: 'https://midden.test',
    }
    const answer = await pooled.run('search', input)
    expect(answer.items.length).toBe(2)
    expect(answer).toEqual(await inline.run('search', input))
    const missing = await pooled
      .run('context', { id: fixture.ids['7']!, origin: '' })
      .catch((e: unknown) => e)
    expect(missing).toMatchObject({ code: 'not_found' })
    // Its connection only reads.
    expect(await pooled.run('folders', undefined)).toEqual({ items: [] })
  })
})

describe('in flight', () => {
  /** Reads that wait until the test lets them answer. */
  function heldReads() {
    const waiting: (() => void)[] = []
    const reads: Reads = {
      run: () =>
        new Promise((resolve) =>
          waiting.push(() => resolve({ items: [] } as never)),
        ),
      close: () => Promise.resolve(),
    }
    return { reads, release: () => waiting.shift()?.() }
  }

  test('a third request waits for a turn, then is turned away busy', async () => {
    const held = heldReads()
    fixture = await agentFixture({
      reads: () => held.reads,
      gate: new Gate({ limit: 2, waitMs: 150 }),
    })
    const f = fixture
    const first = f.call('/folders')
    const second = f.call('/folders')
    const started = performance.now()
    const third = await f.call('/folders')
    expect(performance.now() - started).toBeGreaterThanOrEqual(140)
    expect(third.status).toBe(503)
    expect(third.json.error).toBe('busy')
    expect(third.headers.get('Retry-After')).toBe('2')
    held.release()
    held.release()
    expect((await first).status).toBe(200)
    expect((await second).status).toBe(200)
  })

  test('a waiting request runs as soon as one ends', async () => {
    const held = heldReads()
    fixture = await agentFixture({
      reads: () => held.reads,
      gate: new Gate({ limit: 2, waitMs: 2000 }),
    })
    const f = fixture
    const calls = [f.call('/folders'), f.call('/folders'), f.call('/folders')]
    await new Promise((resolve) => setTimeout(resolve, 20))
    held.release()
    await new Promise((resolve) => setTimeout(resolve, 20))
    held.release()
    held.release()
    expect((await Promise.all(calls)).map((r) => r.status)).toEqual([
      200, 200, 200,
    ])
  })

  test('a read that times out answers 503 query_timeout', async () => {
    fixture = await agentFixture({
      reads: () => ({
        run: () =>
          Promise.reject(
            new AgentError('query_timeout', 'The query took longer than 5 s.'),
          ),
        close: () => Promise.resolve(),
      }),
    })
    const response = await fixture.call('/posts?q=cat')
    expect(response.status).toBe(503)
    expect(response.json).toEqual({
      error: 'query_timeout',
      message: 'The query took longer than 5 s.',
    })
  })
})
