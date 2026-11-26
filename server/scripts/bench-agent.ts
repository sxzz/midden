// Time the agent API's reads on a copy of a real database, on this thread and
// on the read threads, and how long the event loop stalls meanwhile:
//
//   node scripts/bench-agent.ts <db> [rounds=5]
//
// The database is copied (SQLite's online backup, safe beside a running
// server) into a temporary directory and migrated there; the original is
// only read.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { backup, DatabaseSync } from 'node:sqlite'
import { QueryPool, READ_THREAD } from '#agent/pool.ts'
import { inlineReads, pooledReads, type Reads } from '#agent/runner.ts'
import { FsBlobStore } from '#blob/fs-store.ts'
import { MediaSigner } from '#blob/signer.ts'
import { openDatabase } from '#db/client.ts'
import type { AgentReader, Params } from '#agent/query.ts'
import type { ReadThreadData } from '#agent/worker.ts'

const [file, rounds = '5'] = process.argv.slice(2)
if (!file) {
  console.error('usage: bench-agent.ts <db> [rounds]')
  process.exit(2)
}

const dir = mkdtempSync(path.join(tmpdir(), 'midden-bench-agent-'))
const copy = path.join(dir, 'midden.db')
const source = new DatabaseSync(file, { readOnly: true })
await backup(source, copy)
source.close()
const db = openDatabase(copy)
const key = new TextEncoder().encode('bench')
const types = {
  platforms: ['instagram', 'x'],
  posts: ['instagram.post', 'x.post'],
  accounts: ['instagram.profile', 'x.profile'],
}
const reader: AgentReader = {
  db,
  blobs: new FsBlobStore(dir, new MediaSigner({ secret: key })),
  types,
}
const pool = new QueryPool({
  script: READ_THREAD,
  workerData: {
    databasePath: copy,
    mediaDir: dir,
    mediaKey: key,
    types,
  } satisfies ReadThreadData,
})

const searches: [string, 'posts' | 'accounts', Params][] = [
  ['posts, newest', 'posts', {}],
  ['posts, q=猫', 'posts', { q: ['猫'] }],
  ['posts, q=photo, full', 'posts', { q: ['photo'], view: ['full'] }],
  ['posts, q=ai (every row)', 'posts', { q: ['ai'] }],
  ['posts, video, 50', 'posts', { media_type: ['video'], size: ['50'] }],
  ['accounts by followers', 'accounts', { sort: ['followers'] }],
]

/** The longest the event loop went without running a timer while `work` ran. */
async function measure(work: () => Promise<unknown>) {
  let last = performance.now()
  let stall = 0
  const timer = setInterval(() => {
    const now = performance.now()
    stall = Math.max(stall, now - last)
    last = now
  }, 2)
  const started = performance.now()
  await work()
  const ms = performance.now() - started
  clearInterval(timer)
  return { ms, stall: Math.max(stall, performance.now() - last) }
}

async function run(label: string, reads: Reads) {
  for (const [name, kind, params] of searches) {
    const times: number[] = []
    const stalls: number[] = []
    for (let i = 0; i < Number(rounds); i++) {
      const { ms, stall } = await measure(() =>
        reads.run('search', { kind, params, origin: 'https://bench' }),
      )
      times.push(ms)
      stalls.push(stall)
    }
    times.sort((a, b) => a - b)
    console.info(
      `${label.padEnd(8)} ${name.padEnd(26)} median ${times[times.length >> 1]!.toFixed(1)} ms, longest stall ${Math.max(...stalls).toFixed(1)} ms`,
    )
  }
}

// Warm both, so neither pays for opening or the page cache.
await inlineReads(reader).run('search', {
  kind: 'posts',
  params: {},
  origin: '',
})
await pooledReads(pool).run('search', { kind: 'posts', params: {}, origin: '' })
await run('inline', inlineReads(reader))
await run('threads', pooledReads(pool))
await pool.close()
db.$client.close()
