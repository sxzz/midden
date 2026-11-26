import { performance } from 'node:perf_hooks'
import { afterEach, describe, expect, test } from 'vitest'
import { agentFixture, type AgentFixture } from '#testing/agent.ts'
import { AgentError } from './errors.ts'
import { Gate } from './gate.ts'
import type { Reads } from './runner.ts'

let fixture: AgentFixture | undefined
afterEach(async () => {
  await fixture?.ctx.queue.stop()
  fixture = undefined
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
