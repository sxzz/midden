// Load test: a heavy update on a copy of a database, with the web process
// measured from outside meanwhile (/healthz and a list request).
//
//   node scripts/bench-load.ts <data dir> <all|split|entry=<file>> [options]
//
// The data directory holds the copy (midden.db); it is changed. `all` runs
// this tree's server in one process, `split` as a web process and a worker,
// `entry=<file>` a single-process server entry from another tree that
// takes the fakes of bench-load/fakes.ts (to measure an older version).
//
// Options: profiles=40 (profiles updated), count=300 (posts each, 100 a
// page), seconds=900 (longest wait), litestream=<binary> (replicate to a
// local directory with the checkpoint settings of litestream.yml),
// litestream-config=<file> (another litestream.yml to take them from),
// pin=<seconds> (30 s into the update, hold a read transaction that long,
// as a backup or a long report would).
//
// Every post has an image, one in ten a video too; media upload to a fake
// R2 bucket, raw responses to a fake raw bucket, thumbnails go through
// ffmpeg (FFMPEG, default `ffmpeg`).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { FakeS3 } from '#testing/fake-s3.ts'
import type { Sample } from './bench-load/probe.ts'
import type { Buffer } from 'node:buffer'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const [dataArg, mode, ...rest] = process.argv.slice(2)
if (!dataArg || !mode) {
  console.error(
    'usage: bench-load.ts <data dir> <all|split|entry=<file>> [profiles=40] [count=300] [seconds=900] [litestream=<binary>]',
  )
  process.exit(2)
}
const options = Object.fromEntries(
  rest.map((arg) => arg.split('=', 2) as [string, string]),
)
const PROFILES = Number(options.profiles ?? 40)
const COUNT = Number(options.count ?? 300)
const SECONDS = Number(options.seconds ?? 900)
const DATA = path.resolve(dataArg)
const DB = path.join(DATA, 'midden.db')
const FFMPEG = process.env.FFMPEG || 'ffmpeg'
const SECRET = 's'.repeat(48)

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  await new Promise((resolve) => server.close(resolve))
  return port
}

function samples() {
  const dir = path.join(DATA, 'bench')
  mkdirSync(dir, { recursive: true })
  const image = path.join(dir, 'sample.jpg')
  const video = path.join(dir, 'sample.mp4')
  const run = (args: string[]) => {
    const result = spawnSync(FFMPEG, ['-y', '-loglevel', 'error', ...args])
    if (result.status !== 0) throw new Error(String(result.stderr))
  }
  run(['-f', 'lavfi', '-i', 'testsrc=size=1280x960', '-frames:v', '1', image])
  run([
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=3:size=640x360:rate=24',
    '-pix_fmt',
    'yuv420p',
    video,
  ])
  return { image, video }
}

/** An API token, written straight into the copy (no migration runs). */
function token(): string {
  const value = `md_bench${Date.now()}`
  const db = new DatabaseSync(DB)
  db.prepare(
    'INSERT INTO api_tokens (id, digest, name, created_at) VALUES (?, ?, ?, ?)',
  ).run(
    `bench${Date.now()}`,
    createHash('sha256').update(value).digest('hex'),
    'bench',
    Date.now(),
  )
  db.close()
  return value
}

/** Checkpoint settings of a litestream.yml, by key. */
function checkpointSettings(file: string): Record<string, string> {
  const text = readFileSync(file, 'utf8')
  const settings: Record<string, string> = {}
  for (const key of [
    'checkpoint-interval',
    'min-checkpoint-page-count',
    'truncate-page-n',
    'busy-timeout',
    'monitor-interval',
  ]) {
    const match = new RegExp(String.raw`^\s+${key}:\s*(\S+)`, 'm').exec(text)
    if (match) settings[key] = match[1]!
  }
  return settings
}

const children: ChildProcess[] = []
function start(
  name: string,
  command: string,
  args: string[],
  env: Record<string, string>,
) {
  const log = path.join(DATA, 'bench', `${name}.log`)
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const chunks: Buffer[] = []
  child.stdout!.on('data', (chunk: Buffer) => chunks.push(chunk))
  child.stderr!.on('data', (chunk: Buffer) => chunks.push(chunk))
  child.once('exit', () => writeFileSync(log, chunks.join('')))
  children.push(child)
  return { child, log, text: () => chunks.join('') }
}

async function waitHealthy(url: string) {
  for (let i = 0; i < 600; i++) {
    try {
      if ((await fetch(url)).ok) return
    } catch {}
    await sleep(200)
  }
  throw new Error(`${url} never answered`)
}

function stats(list: Sample[]) {
  const ms = list.map((s) => s.ms).toSorted((a, b) => a - b)
  const at = (p: number) =>
    ms[Math.min(ms.length - 1, Math.floor(ms.length * p))] ?? 0
  return {
    n: ms.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: ms.at(-1) ?? 0,
    over500: ms.filter((v) => v >= 500).length,
    over1s: ms.filter((v) => v >= 1000).length,
    errors: list.filter((s) => !s.ok).length,
  }
}

const media = await samples()
const s3Media = await new FakeS3({ bucket: 'media' }).start()
const s3Raw = await new FakeS3({ bucket: 'raw' }).start()
const apiToken = token()
const port = await freePort()
const base = `http://127.0.0.1:${port}`
const env = {
  DATA_DIR: DATA,
  HOST: '127.0.0.1',
  PORT: String(port),
  WORKER_HEALTH_PORT: String(await freePort()),
  SECRET_KEY: SECRET,
  NODE_ENV: 'production',
  LOG_LEVEL: 'info',
  FFMPEG,
  BENCH_S3_MEDIA: s3Media.endpoint,
  BENCH_S3_RAW: s3Raw.endpoint,
  BENCH_IMAGE: media.image,
  BENCH_VIDEO: media.video,
}
const server = path.join(HERE, 'bench-load', 'server.ts')
const servers =
  mode === 'split'
    ? [
        start('web', process.execPath, [server], {
          ...env,
          MIDDEN_ROLE: 'web',
        }),
        start('worker', process.execPath, [server], {
          ...env,
          MIDDEN_ROLE: 'worker',
        }),
      ]
    : [
        mode === 'all'
          ? start('all', process.execPath, [server], {
              ...env,
              MIDDEN_ROLE: 'all',
            })
          : start(
              'entry',
              process.execPath,
              [mode.replace(/^entry=/, '')],
              env,
            ),
      ]
await waitHealthy(`${base}/healthz`)

let litestream: ReturnType<typeof start> | undefined
if (options.litestream) {
  const settings = checkpointSettings(
    options['litestream-config'] ??
      path.join(HERE, '..', '..', 'litestream.yml'),
  )
  const config = path.join(DATA, 'bench', 'litestream.yml')
  writeFileSync(
    config,
    [
      'dbs:',
      `  - path: ${DB}`,
      ...Object.entries(settings).map(([k, v]) => `    ${k}: ${v}`),
      '    replica:',
      `      url: file://${path.join(DATA, 'bench', 'replica')}`,
      '      sync-interval: 1s',
      '',
    ].join('\n'),
  )
  console.info(`litestream: ${JSON.stringify(settings)}`)
  litestream = start(
    'litestream',
    options.litestream,
    ['replicate', '-config', config],
    {},
  )
}

const api = async (route: string, body: unknown) => {
  const response = await fetch(`${base}/v1${route}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!response.ok)
    throw new Error(`${route}: ${response.status} ${await response.text()}`)
  return response.json() as Promise<Record<string, unknown>>
}

const reader = new DatabaseSync(DB, { readOnly: true })
const backlog = () =>
  Object.fromEntries(
    (
      reader
        .prepare('SELECT type, count(*) AS n FROM jobs GROUP BY type')
        .all() as { type: string; n: number }[]
    ).map((row) => [row.type, row.n]),
  )
const FOREGROUND = [
  'capture',
  'related',
  'update',
  'finalize',
  'download',
  'relations',
]
const busy = () => {
  const jobs = backlog()
  return FOREGROUND.some((type) => jobs[type])
}

// The profiles, saved first without their posts.
const ids: string[] = []
for (let p = 0; p < PROFILES; p++) {
  const job = await api('/captures', {
    url: `https://fake.test/u/${900_000 + p}`,
    options: { posts: 'none' },
  })
  ids.push(String(job.collection_id))
}
while (busy()) await sleep(500)
console.info(`${PROFILES} profiles saved`)

const probe = start(
  'probe',
  process.execPath,
  [path.join(HERE, 'bench-load', 'probe.ts'), base, apiToken, ids[0]!],
  {},
)
await sleep(10_000)
const finishedBefore = (
  reader
    .prepare(
      "SELECT count(*) AS n FROM captures WHERE state IN ('complete', 'partial')",
    )
    .get() as { n: number }
).n
const t0 = performance.now()
await api('/updates', {
  target: { target: 'many', ids },
  options: { posts: 'latest', count: COUNT },
})
const walBytes = () => {
  try {
    return statSync(`${DB}-wal`).size
  } catch {
    return 0
  }
}
let walMax = walBytes()
const walTimer = setInterval(
  () => (walMax = Math.max(walMax, walBytes())),
  1000,
)
if (options.pin) {
  const pinned = new DatabaseSync(DB, { readOnly: true })
  setTimeout(() => {
    pinned.exec('BEGIN')
    pinned.prepare('SELECT count(*) FROM collections').get()
    console.info(`holding a read transaction for ${options.pin} s`)
    setTimeout(
      () => {
        pinned.exec('COMMIT')
        pinned.close()
        console.info('read transaction ended')
      },
      Number(options.pin) * 1000,
    )
  }, 30_000)
}
let done = 0
for (;;) {
  await sleep(5000)
  const elapsed = (performance.now() - t0) / 1000
  const jobs = backlog()
  const finished =
    (
      reader
        .prepare(
          "SELECT count(*) AS n FROM captures WHERE state IN ('complete', 'partial')",
        )
        .get() as { n: number }
    ).n - finishedBefore
  console.info(
    `${elapsed.toFixed(0).padStart(4)} s  captures ${finished}  ${JSON.stringify(jobs)}`,
  )
  if (FOREGROUND.every((type) => !jobs[type])) {
    done = elapsed
    break
  }
  if (elapsed > SECONDS) break
}
const loadSeconds = (performance.now() - t0) / 1000
const captured =
  (
    reader
      .prepare(
        "SELECT count(*) AS n FROM captures WHERE state IN ('complete', 'partial')",
      )
      .get() as { n: number }
  ).n - finishedBefore
const leftBehind = backlog()
clearInterval(walTimer)
await sleep(2000)
probe.child.kill('SIGTERM')
await once(probe.child, 'exit')
const probed = JSON.parse(probe.text().trim().split('\n').at(-1)!) as Record<
  string,
  Sample[]
>
// The probe ran 10 s before the update started.
const during = (list: Sample[]) =>
  list.filter((s) => s.t >= 10_000 && s.t <= 10_000 + loadSeconds * 1000)
for (const child of children.filter((c) => c !== probe.child))
  child.kill('SIGTERM')
await Promise.all(
  children.filter((c) => c.exitCode === null).map((c) => once(c, 'exit')),
)
const logs = servers.map((s) => s.text()).join('\n')
const count = (pattern: string) => logs.split(pattern).length - 1
const result = {
  mode,
  profiles: PROFILES,
  posts: COUNT,
  load_seconds: Math.round(loadSeconds),
  finished: done > 0,
  captures: captured,
  captures_per_second: Math.round((captured / loadSeconds) * 10) / 10,
  backlog_after: leftBehind,
  healthz: stats(during(probed.healthz!)),
  list: stats(during(probed.list!)),
  write: stats(during(probed.write!)),
  baseline: {
    healthz: stats(probed.healthz!.filter((s) => s.t < 10_000)),
    list: stats(probed.list!.filter((s) => s.t < 10_000)),
  },
  log: {
    locked: count('database is locked'),
    slow_requests: count('"msg":"slow request"'),
    lag: count('"msg":"event loop lag"'),
    slow_writes: count('"msg":"slow write transaction"'),
    job_failed: count('"msg":"job failed"'),
    slowing: count('"msg":"worker slowing down"'),
  },
  litestream: litestream
    ? {
        truncates:
          litestream.text().split('forcing truncate checkpoint').length - 1,
        errors: litestream.text().split('level=ERROR').length - 1,
      }
    : false,
  pin_seconds: Number(options.pin ?? 0),
  wal_max_mb: Math.round(walMax / 2 ** 20),
}
writeFileSync(
  path.join(DATA, 'bench', 'result.json'),
  JSON.stringify(result, null, 2),
)
writeFileSync(path.join(DATA, 'bench', 'probe.json'), JSON.stringify(probed))
console.info(JSON.stringify(result, null, 2))
reader.close()
await s3Media.stop()
await s3Raw.stop()
process.exit(0)
