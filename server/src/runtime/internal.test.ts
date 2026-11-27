import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, test } from 'vitest'
import { pressure } from '#jobs/throttle.ts'
import { recordingLogger } from '#testing/logs.ts'
import {
  fetchWorkerReport,
  internalServer,
  LOAD_PATH,
  STATUS_PATH,
  WebProbe,
} from './internal.ts'
import type { AddressInfo } from 'node:net'

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

async function serve(routes: Parameters<typeof internalServer>[0]['routes']) {
  const { logger } = recordingLogger()
  const server = internalServer({
    host: '127.0.0.1',
    port: 0,
    logger,
    name: 'test',
    routes,
  })
  servers.push(server)
  await once(server, 'listening')
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const quiet = {
  lagSeconds: [12, 15],
  lagP99Ms: 15,
  lagMaxMs: 30,
  slowRequests: 0,
  threadSlowRequests: 3,
}
const writes = { count: 0, waitMs: 0, maxWaitMs: 0, holdMs: 0, maxHoldMs: 0 }

describe('internal ports', () => {
  test('answer their paths, and nothing else', async () => {
    const url = await serve({
      '/healthz': () => ({ text: 'ok' }),
      [STATUS_PATH]: () => ({ json: { at: 1 } }),
      '/beat': () => ({ status: 204 }),
    })
    expect(await (await fetch(`${url}/healthz`)).text()).toBe('ok')
    expect(await (await fetch(`${url}${STATUS_PATH}`)).json()).toEqual({
      at: 1,
    })
    expect((await fetch(`${url}/beat`)).status).toBe(204)
    expect((await fetch(`${url}/other`)).status).toBe(404)
    expect((await fetch(`${url}/healthz`, { method: 'POST' })).status).toBe(404)
  })

  test("the web process reads the worker's report, or none", async () => {
    const url = await serve({ [STATUS_PATH]: () => ({ json: { at: 7 } }) })
    expect(await fetchWorkerReport(url)).toEqual({ at: 7 })
    expect(await fetchWorkerReport('http://127.0.0.1:1')).toBeUndefined()
  })

  test("the worker reads the web process's load", async () => {
    const url = await serve({ [LOAD_PATH]: () => ({ json: quiet }) })
    const probe = new WebProbe(url)
    await probe.probe()
    expect(probe.signal()).toEqual(quiet)
  })

  test('a web process that does not answer in time reads as stalled', async () => {
    // Accepts the connection and never answers, as a stalled event loop.
    const silent = createServer(() => {})
    servers.push(silent)
    silent.listen(0, '127.0.0.1')
    await once(silent, 'listening')
    const probe = new WebProbe(
      `http://127.0.0.1:${(silent.address() as AddressInfo).port}`,
    )
    await probe.probe(250)
    // Two stalled seconds: high for the throttle, which halves only when
    // the next probe stalls too.
    expect(
      pressure({ web: probe.signal(), writes, elapsedMs: 1000 }),
    ).toMatchObject({ pressure: 'high', signal: 'web_lag' })
  })

  test('one that is not there gives no reading, and an old reading expires', async () => {
    let now = 0
    const url = await serve({ [LOAD_PATH]: () => ({ json: quiet }) })
    const probe = new WebProbe(url, () => now)
    await probe.probe()
    now += 6000
    expect(probe.signal()).toBeUndefined()
    const gone = new WebProbe('http://127.0.0.1:1', () => now)
    await gone.probe()
    expect(gone.signal()).toBeUndefined()
  })
})
