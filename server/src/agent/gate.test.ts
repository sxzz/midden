import { performance } from 'node:perf_hooks'
import { afterEach, describe, expect, test } from 'vitest'
import { agentFixture, type AgentFixture } from '#testing/agent.ts'
import { addViewer } from '#testing/users.ts'
import { createToken } from '#tokens/tokens.ts'
import { AgentError } from './errors.ts'
import { Gate, ViewerGates } from './gate.ts'
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

  test('viewers: one request each, two of theirs at once, never the admin’s turns', async () => {
    const held = heldReads()
    fixture = await agentFixture({
      reads: () => held.reads,
      gate: new Gate({ limit: 2, waitMs: 150 }),
      viewerGates: new ViewerGates({ limit: 2, perUser: 1, waitMs: 150 }),
    })
    const f = fixture
    const tokenOf = (name: string) =>
      createToken(f.ctx.db, {
        user: addViewer(f.ctx.db, name),
        label: name,
        permission: 'ro',
      }).secret
    const [a, b, c] = ['a', 'b', 'c'].map(tokenOf) as [string, string, string]
    const first = f.call('/folders', { token: a })
    // A's second waits for A's first, then is turned away.
    const again = await f.call('/folders', { token: a })
    expect([again.status, again.json.error]).toEqual([503, 'busy'])
    expect(again.headers.get('Retry-After')).toBe('2')
    // B has a turn; then the viewers' two are taken, and C is turned away.
    const second = f.call('/folders', { token: b })
    const third = await f.call('/folders', { token: c })
    expect([third.status, third.json.error]).toEqual([503, 'busy'])
    // The admin's two turns are all theirs still.
    const owner = [f.call('/folders'), f.call('/folders')]
    await new Promise((resolve) => setTimeout(resolve, 20))
    for (let i = 0; i < 4; i++) held.release()
    expect(
      (await Promise.all([first, second, ...owner])).map((r) => r.status),
    ).toEqual([200, 200, 200, 200])
    // whoami says the viewer's own limit and their lane's.
    const whoami = await f.call('/whoami', { token: a })
    expect(whoami.json).toMatchObject({
      user: { name: 'a', role: 'viewer' },
      token: { permission: 'ro' },
      limits: { in_flight: 1, lane_in_flight: 2, query_timeout_ms: 5000 },
    })
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
