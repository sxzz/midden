import { Hono } from 'hono'
import { describe, expect, test } from 'vitest'
import { recordingLogger } from '#testing/logs.ts'
import { WebLoad } from './load.ts'
import { inline, offload, type WebReads } from './offload.ts'
import type { Env } from './validate.ts'

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
      lagSeconds: [9],
      lagP99Ms: 9,
      lagMaxMs: 15,
      slowRequests: 0,
      threadSlowRequests: 0,
    })
    expect(load.report()).toEqual({
      window_s: 60,
      lag_p99_ms: 250,
      lag_max_ms: 900,
      requests: {
        count: 6,
        p50_ms: 8,
        p95_ms: 800,
        max_ms: 800,
        slow: 1,
        slow_thread: 0,
      },
    })
    now += 60_000
    expect(load.report().requests.count).toBe(0)
  })

  test('slow requests on read threads are counted and logged apart', () => {
    const { logger, entries } = recordingLogger()
    const load = new WebLoad({ logger, now: () => 0 })
    const request = { method: 'GET', path: '/v1/captures', status: 200 }
    load.recordRequest(3000, request, { waitMs: 120, runMs: 2880 })
    load.recordRequest(1500, request, { waitMs: 0, runMs: 1500 })
    // Its own line, though a threaded one was logged just before.
    load.recordRequest(700, { ...request, path: '/v1/session' })
    expect(load.signal()).toMatchObject({
      slowRequests: 1,
      threadSlowRequests: 2,
    })
    expect(load.report().requests).toMatchObject({ slow: 1, slow_thread: 2 })
    expect(
      entries.map(({ msg, path, thread, waitMs, runMs, skipped }) => ({
        msg,
        path,
        thread,
        waitMs,
        runMs,
        skipped,
      })),
    ).toEqual([
      {
        msg: 'slow request',
        path: '/v1/captures',
        thread: true,
        waitMs: 120,
        runMs: 2880,
        skipped: 0,
      },
      {
        msg: 'slow request',
        path: '/v1/session',
        thread: false,
        waitMs: undefined,
        runMs: undefined,
        skipped: 0,
      },
    ])
  })

  test('the middleware times each request', async () => {
    const { logger } = recordingLogger()
    const load = new WebLoad({ logger })
    const app = new Hono().use(load.middleware()).get('/x', (c) => c.text('ok'))
    await app.request('/x')
    expect(load.report().requests.count).toBe(1)
  })

  test('the middleware knows a request the read threads answered', async () => {
    const { logger } = recordingLogger()
    const load = new WebLoad({ logger, slowRequestMs: 0 })
    const reads: WebReads = {
      run: (_request, onStart) => {
        onStart?.()
        return Promise.resolve({
          status: 200,
          headers: [],
          body: new ArrayBuffer(0),
        })
      },
    }
    const app = new Hono<Env>()
      .use(load.middleware())
      .use(offload(reads))
      .get('/threaded', (c) => c.text('never here'))
      .get('/here', inline, (c) => c.text('ok'))
    await app.request('/threaded')
    await app.request('/here')
    expect(load.signal()).toMatchObject({
      slowRequests: 1,
      threadSlowRequests: 1,
    })
  })
})
