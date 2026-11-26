// Measures the web process from outside while the load test runs: /healthz
// every 100 ms, the first page of the library every 500 ms and, given a
// collection, a small write (its note) every second; each request waits for
// the one before. With `ui`, instead of the library every 500 ms it polls
// what the web app polls during an update, each every second: the capture
// records, the newest record's detail, the capture accounts, the folders
// and the library. Prints the samples as JSON when stopped (SIGTERM).
//
//   node scripts/bench-load/probe.ts <base URL> <token> [collection id] [ui]
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'

const [base, token, collection, ui] = process.argv.slice(2)
if (!base || !token) {
  console.error('usage: probe.ts <base URL> <token>')
  process.exit(2)
}

export interface Sample {
  /** Milliseconds since the probe started. */
  t: number
  ms: number
  ok: boolean
}

const started = performance.now()
const samples: Record<string, Sample[]> = { healthz: [], list: [], write: [] }
let stopped = false
/** The newest capture record, from the last list read. */
let newest = ''

async function stream(
  name: string,
  path: string | (() => string),
  every: number,
  write?: () => string,
) {
  samples[name] ??= []
  while (!stopped) {
    const t = performance.now()
    let ok = false
    try {
      const response = await fetch(
        `${base}${typeof path === 'string' ? path : path()}`,
        {
          method: write ? 'PATCH' : 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            ...(write ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(write ? { body: write() } : {}),
          signal: AbortSignal.timeout(30_000),
        },
      )
      const body = await response.arrayBuffer()
      ok = response.ok
      if (ok && name === 'records')
        newest =
          (
            JSON.parse(new TextDecoder().decode(body)) as {
              items: { id: string }[]
            }
          ).items[0]?.id ?? ''
    } catch {}
    const ms = performance.now() - t
    samples[name]!.push({
      t: Math.round(t - started),
      ms: Math.round(ms * 10) / 10,
      ok,
    })
    await sleep(Math.max(0, every - ms))
  }
}

function finish() {
  stopped = true
  process.stdout.write(`${JSON.stringify(samples)}\n`, () => process.exit(0))
}
process.on('SIGTERM', finish)
process.on('SIGINT', finish)
let notes = 0
await Promise.all([
  stream('healthz', '/healthz', 100),
  ...(ui
    ? [
        stream('records', '/v1/captures', 1000),
        stream(
          'record',
          () => (newest ? `/v1/captures/${newest}` : '/v1/captures'),
          1000,
        ),
        stream('accounts', '/v1/accounts', 1000),
        stream('folders', '/v1/folders', 1000),
        stream('collections', '/v1/collections', 1000),
      ]
    : [stream('list', '/v1/collections', 500)]),
  collection &&
    stream('write', `/v1/collections/${collection}/annotation`, 1000, () =>
      JSON.stringify({ note: `probe ${++notes}` }),
    ),
])
