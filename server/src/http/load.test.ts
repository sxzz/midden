import { Hono } from 'hono'
import { describe, expect, test } from 'vitest'
import { recordingLogger } from '#testing/logs.ts'
import { WebLoad } from './load.ts'

describe('web load', () => {
  test('slow requests and stalls are logged, at most one line in 10 s', () => {
    let now = 0
    const { logger, entries } = recordingLogger()
    const load = new WebLoad({ logger, now: () => now })
    const request = { method: 'GET', path: '/v1/collections', status: 200 }
    load.recordRequest(20, request)
    load.recordRequest(700, request)
    load.recordRequest(900, request)
    now += 10_000
    load.recordRequest(600, request)
    load.recordLag(30, 80)
    load.recordLag(150, 450)
    expect(entries.map((l) => [l.msg, l.ms ?? l.lagMs, l.skipped])).toEqual([
      ['slow request', 700, 0],
      ['slow request', 600, 1],
      ['event loop lag', 450, 0],
    ])
  })

  test('the last seconds for the throttle, the last minute for the page', () => {
    let now = 100_000
    const { logger } = recordingLogger()
    const load = new WebLoad({ logger, now: () => now })
    const request = { method: 'GET', path: '/healthz', status: 200 }
    load.recordLag(250, 900)
    load.recordRequest(800, request)
    now += 10_000
    for (const ms of [2, 4, 6, 8, 10]) load.recordRequest(ms, request)
    load.recordLag(9, 15)
    // The stall was 10 s ago: the throttle no longer sees it.
    expect(load.signal()).toEqual({
      lagP99Ms: 9,
      lagMaxMs: 15,
      slowRequests: 0,
    })
    expect(load.report()).toEqual({
      window_s: 60,
      lag_p99_ms: 250,
      lag_max_ms: 900,
      requests: { count: 6, p50_ms: 8, p95_ms: 800, max_ms: 800, slow: 1 },
    })
    now += 60_000
    expect(load.report().requests.count).toBe(0)
  })

  test('the middleware times each request', async () => {
    const { logger } = recordingLogger()
    const load = new WebLoad({ logger })
    const app = new Hono().use(load.middleware()).get('/x', (c) => c.text('ok'))
    await app.request('/x')
    expect(load.report().requests.count).toBe(1)
  })
})
