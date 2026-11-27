// Time the API's writes and their dry runs (POST, PUT, PATCH, DELETE) on a
// copy of a real database, as the web process serves them: `GET` and what
// is marked to read on the read threads, the rest on this thread. For each,
// the response time and the longest the event loop stood still meanwhile
// (what every other request waited).
//
//   node scripts/bench-writes.ts <db> [runs=3]
//
// The copy is grown first to sizes the owner's library reaches: a profile
// with 3,000 posts that all carry videos, a tag on 8,000 posts and a folder
// of it, a second tag on 3,000, and an update of that folder with 8,000
// members and 4,000 waiting jobs. Writes that cannot be repeated (removing
// media, merging a tag, deleting) run once, at the end.
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { backup, DatabaseSync } from 'node:sqlite'
import { pino } from 'pino'
import { Vault } from '#accounts/vault.ts'
import { createAgentApi } from '#agent/app.ts'
import { pooledReads, typeCatalog } from '#agent/runner.ts'
import { FsBlobStore } from '#blob/fs-store.ts'
import { KeyedLock } from '#blob/locks.ts'
import { MediaSigner } from '#blob/signer.ts'
import { rebuildProgress } from '#capture/progress.ts'
import { startUpdate } from '#capture/updates.ts'
import { openDatabase } from '#db/client.ts'
import { createApi, SESSION_COOKIE } from '#http/app.ts'
import { pooledWebReads } from '#http/offload.ts'
import { createSession } from '#http/sessions.ts'
import { JobQueue, type JobHandler } from '#jobs/queue.ts'
import { createFolder } from '#library/folders.ts'
import { createInstagramPlatform } from '#platforms/instagram/index.ts'
import { Platforms } from '#platforms/registry.ts'
import { createXPlatform } from '#platforms/x/index.ts'
import { QueryPool, READ_THREAD } from '#reads/pool.ts'
import { fakePlatform } from '#testing/fake-platform.ts'
import { createToken } from '#tokens/tokens.ts'
import { TokenUsage } from '#tokens/usage.ts'
import { adminId } from '#users/users.ts'
import type { AccountsContext } from '#accounts/accounts.ts'
import type { ReadThreadData } from '#reads/thread.ts'

const [file, runsArg = '3', only] = process.argv.slice(2)
if (!file) {
  console.error('usage: bench-writes.ts <db> [runs]')
  process.exit(2)
}
const RUNS = Number(runsArg)

const dir = mkdtempSync(path.join(tmpdir(), 'midden-bench-writes-'))
const copy = path.join(dir, 'midden.db')
{
  const source = new DatabaseSync(file, { readOnly: true })
  await backup(source, copy)
  source.close()
}
// As the web process opens it: checkpoints are the worker's, not a request's.
const db = openDatabase(copy, { autoCheckpoint: false })
const client = db.$client
const one = <T>(query: string, ...args: (string | number)[]) =>
  client.prepare(query).get(...args) as T
const all = <T>(query: string, ...args: (string | number)[]) =>
  client.prepare(query).all(...args) as T[]

// --- Growing the copy ---------------------------------------------------------
const logger = pino({ level: 'silent' })
const noop: JobHandler = { queue: 'control', run: async () => {} }
const queue = new JobQueue({
  db,
  logger,
  handlers: {
    capture: { ...noop, queue: 'capture' },
    download: { ...noop, queue: 'download' },
    upload: { ...noop, queue: 'upload' },
    'raw-upload': { ...noop, queue: 'raw' },
    finalize: noop,
    related: noop,
    relations: { ...noop, queue: 'capture' },
    update: noop,
    'video-removal': noop,
  },
  concurrency: { capture: 4, download: 8, control: 4, upload: 4, raw: 4 },
})
const vault = new Vault(new Uint8Array(32).fill(7))
const key = new TextEncoder().encode('bench')
const signer = new MediaSigner({ secret: key })
const platforms = new Platforms([
  createXPlatform(),
  createInstagramPlatform(),
  fakePlatform({ current: () => ({}) }),
])
const ctx: AccountsContext = {
  db,
  queue,
  logger,
  platforms,
  blobs: new FsBlobStore(path.join(dir, 'media'), signer),
  vault,
  openCredential: (ref) => vault.open(db, ref),
  mediaLocks: new KeyedLock(),
}

const seeded = performance.now()
// The profile with the most posts takes 3,000 more, every one with videos.
const profile = one<{ id: string; entity: string }>(`
  SELECT k.collection_id AS id, k.root_entity_id AS entity
  FROM catalog k JOIN library l ON l.collection_id = k.collection_id
  WHERE k.root_kind LIKE '%.profile'
  ORDER BY (SELECT count(*) FROM catalog p
    WHERE p.author_entity_id = k.root_entity_id) DESC
  LIMIT 1`)
const version = one<{ id: string }>(
  `SELECT id FROM entity_versions WHERE entity_id = ?
  ORDER BY created_at DESC LIMIT 1`,
  profile.entity,
).id
const posts = all<{ id: string; revision: string }>(
  `SELECT k.collection_id AS id, k.revision_id AS revision
  FROM catalog k JOIN library l ON l.collection_id = k.collection_id
  WHERE k.root_kind = 'x.post' AND coalesce(k.author_entity_id, '') <> ?
  ORDER BY k.collection_id`,
  profile.entity,
)
const theirs = posts.slice(0, 3000)
client.exec('BEGIN')
const author = client.prepare(`
  UPDATE revision_entities SET entity_version_id = ?
  WHERE revision_id = ? AND entity_key IN (SELECT target_key
    FROM entity_relations WHERE revision_id = ? AND kind = 'authored_by')`)
const authored = client.prepare(
  'UPDATE catalog SET author_entity_id = ? WHERE collection_id = ?',
)
const videos = client.prepare(`
  UPDATE assets SET kind = 'video' WHERE purpose = ''
    AND capture_id IN (SELECT id FROM captures WHERE collection_id = ?)`)
for (const post of theirs) {
  author.run(version, post.revision, post.revision)
  authored.run(profile.entity, post.id)
  videos.run(post.id)
}
// Two tags: one on 8,000 posts, one on 3,000 (half of them both).
const big = randomUUID()
const small = randomUUID()
client
  .prepare('INSERT INTO tags (id, name) VALUES (?, ?), (?, ?)')
  .run(big, 'bench-big', small, 'bench-small')
const tag = client.prepare(
  'INSERT OR IGNORE INTO collection_tags (collection_id, tag_id) VALUES (?, ?)',
)
const tagged = posts.slice(3000, 11_000)
for (const post of tagged) tag.run(post.id, big)
for (const post of posts.slice(9500, 12_500)) tag.run(post.id, small)
client.exec('COMMIT')
const folder = createFolder(db, { name: 'bench', filter: `tag=${big}` }).id
// An update of the folder: every member submitted, 4,000 jobs waiting.
const update = startUpdate(ctx, { target: 'folder', id: folder })
const members = one<{ ids: string }>(
  'SELECT collection_ids AS ids FROM updates WHERE id = ?',
  update,
)
const memberIds = JSON.parse(members.ids) as string[]
client.exec('BEGIN')
const member = client.prepare(`
  INSERT INTO submissions (id, capture_id, idem_key, fingerprint, input,
    created_at, update_id)
  SELECT ?, c.id, ?, '', co.url, ?, ? FROM captures c
  JOIN collections co ON co.id = c.collection_id
  WHERE c.collection_id = ? ORDER BY c.created_at DESC LIMIT 1`)
const now = Date.now()
for (const [i, id] of memberIds.entries())
  member.run(randomUUID(), `update:${update}:${i}`, now, update, id)
client
  .prepare('UPDATE updates SET position = ? WHERE id = ?')
  .run(memberIds.length, update)
const job = client.prepare(`
  INSERT INTO jobs (type, ref, queue, priority, state, max_attempts, run_at,
    created_at, update_id)
  VALUES ('download', ?, 'download', 1, 'available', 3, ?, ?, ?)`)
for (let i = 0; i < 4000; i++) job.run(randomUUID(), now, now, update)
client.exec('COMMIT')
client.exec('DELETE FROM member_events')
rebuildProgress(db, update)
const mediaPosts = all<{ id: string }>(
  `SELECT DISTINCT c.collection_id AS id FROM assets a
  JOIN captures c ON c.id = a.capture_id
  JOIN library l ON l.collection_id = c.collection_id
  WHERE a.purpose = '' AND a.state = 'ready' AND a.kind = 'image'
  ORDER BY c.collection_id LIMIT 500`,
).map((row) => row.id)
const oneAsset = one<{ collection: string; asset: string }>(
  `SELECT c.collection_id AS collection, a.id AS asset FROM assets a
  JOIN captures c ON c.id = a.capture_id
  WHERE a.purpose = '' AND a.state = 'ready' AND a.kind = 'image'
  ORDER BY a.id LIMIT 1`,
)
console.log(
  `grown in ${Math.round(performance.now() - seeded)} ms: profile ${profile.id} +${theirs.length} posts, ` +
    `folder of ${memberIds.length}, update ${update}`,
)

if (only === 'grow') {
  console.log(
    JSON.stringify({
      copy,
      profile: profile.id,
      folder,
      update,
      big,
      small,
      mediaPosts,
    }),
  )
  await queue.stop()
  process.exit(0)
}

// --- The web process ----------------------------------------------------------
const types = typeCatalog(platforms)
const pool = new QueryPool({
  script: READ_THREAD,
  workerData: {
    databasePath: copy,
    mediaDir: path.join(dir, 'media'),
    mediaKey: key,
    types,
    countPointers: platforms.countPointers(),
    webAppUrl: 'https://midden.test/app/',
  } satisfies ReadThreadData,
})
pool.warm(4)
const forget = () => pool.broadcast('forget')
const usage = new TokenUsage({ db })
const api = createApi({
  ctx,
  webAppUrl: 'https://midden.test/app/',
  reads: pooledWebReads(pool),
  tokenUsage: usage,
  onWrite: forget,
})
const agent = createAgentApi({
  ctx,
  reads: pooledReads(pool),
  reader: { db, blobs: ctx.blobs, types },
  usage,
  onWrite: forget,
})
const session = createSession(db, adminId(db))
const { secret } = createToken(db, {
  user: adminId(db),
  label: 'bench',
  permission: 'rw',
})

interface Call {
  name: string
  method: string
  path: string
  body?: unknown
}

async function request(call: Call): Promise<{ status: number; ms: number }> {
  const agentCall = call.path.startsWith('/agent/')
  const init: RequestInit = {
    method: call.method,
    headers: agentCall
      ? {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json',
        }
      : {
          Cookie: `${SESSION_COOKIE}=${session}`,
          Origin: 'https://midden.test',
          'Content-Type': 'application/json',
        },
    ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
  }
  const started = performance.now()
  const response = agentCall
    ? await agent.request(call.path, init)
    : await api.request(call.path, init)
  await response.arrayBuffer()
  return { status: response.status, ms: performance.now() - started }
}

/** The response time and the event loop's longest standstill meanwhile. */
async function measure(call: Call) {
  let last = performance.now()
  let block = 0
  const tick = setInterval(() => {
    const t = performance.now()
    block = Math.max(block, t - last)
    last = t
  }, 1)
  // A first tick, so a request that blocks at once is measured from here.
  await new Promise((resolve) => setTimeout(resolve, 5))
  last = performance.now()
  const result = await request(call)
  block = Math.max(block, performance.now() - last)
  clearInterval(tick)
  return { ...result, block }
}

const median = (values: number[]) =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!
const fmt = (n: number) => (n < 10 ? n.toFixed(1) : String(Math.round(n)))

const rows: string[][] = []
/** BENCH_ONLY: only the requests whose name has this in it. */
const ONLY = process.env.BENCH_ONLY
async function bench(call: Call, runs = RUNS) {
  if (ONLY && !call.name.includes(ONLY)) return
  const results = []
  for (let i = 0; i < runs; i++) results.push(await measure(call))
  rows.push([
    call.name,
    `${call.method} ${call.path.replaceAll(/[\da-f]{8}-[\da-f-]{27}/g, ':id')}`,
    String(results[0]!.status),
    fmt(median(results.map((r) => r.ms))),
    fmt(median(results.map((r) => r.block))),
    fmt(Math.max(...results.map((r) => r.block))),
  ])
}

// Warm the threads and this connection's page cache alike.
await request({ name: '', method: 'GET', path: '/collections' })
await request({ name: '', method: 'GET', path: `/captures/${update}` })

const T = (body: unknown) => ({ target: body })
const agentT = T
await bench({
  name: 'media removal preview, 500 posts',
  method: 'POST',
  path: '/media-removals/preview',
  body: { ids: mediaPosts },
})
await bench({
  name: 'media removal preview, one item',
  method: 'POST',
  path: '/media-removals/preview',
  body: oneAsset,
})
await bench({
  name: 'video removal preview, 3,000 posts',
  method: 'POST',
  path: `/collections/${profile.id}/video-removal/preview`,
})
await bench({
  name: 'delete preview, profile with posts',
  method: 'POST',
  path: '/collections/delete/preview',
  body: { ids: [profile.id], with_posts: true },
})
await bench({
  name: 'update preview, folder of 8,000',
  method: 'POST',
  path: '/updates/preview',
  body: T({ target: 'folder', id: folder }),
})
await bench({
  name: 'update preview, 500 posts',
  method: 'POST',
  path: '/updates/preview',
  body: T({ target: 'many', ids: mediaPosts }),
})
await bench({
  name: 'update preview, profile',
  method: 'POST',
  path: '/updates/preview',
  body: T({ target: 'collection', id: profile.id }),
})
await bench({
  name: 'update start, folder of 8,000',
  method: 'POST',
  path: '/updates',
  body: T({ target: 'folder', id: folder }),
})
await bench({
  name: 'update start, 500 posts',
  method: 'POST',
  path: '/updates',
  body: T({ target: 'many', ids: mediaPosts }),
})
await bench({
  name: 'update start, profile',
  method: 'POST',
  path: '/updates',
  body: T({ target: 'collection', id: profile.id }),
})
await bench({
  name: 'agent update start, folder',
  method: 'POST',
  path: '/agent/v1/updates',
  body: agentT({ folder }),
})
await bench({
  name: 'update again (retry), folder',
  method: 'POST',
  path: `/captures/${update}/retry`,
})
await bench({
  name: 'update retry failed, 8,000 members',
  method: 'POST',
  path: `/captures/${update}/retry-failed`,
  body: {},
})
await bench({
  name: 'update continue (not a profile)',
  method: 'POST',
  path: `/updates/${update}/continue`,
  body: { collection_id: profile.id },
})
for (let i = 0; i < RUNS; i++) {
  await bench(
    {
      name: 'update pause, 4,000 jobs',
      method: 'POST',
      path: `/updates/${update}/pause`,
    },
    1,
  )
  await bench(
    {
      name: 'update resume, 4,000 jobs',
      method: 'POST',
      path: `/updates/${update}/resume`,
    },
    1,
  )
}
let n = 0
await bench({
  get name() {
    return 'folder create, 8,000 tagged'
  },
  method: 'POST',
  path: '/folders',
  get body() {
    return { name: `bench ${n++}`, filter: `tag=${big}` }
  },
})
await bench({
  name: 'folder filter change',
  method: 'PATCH',
  path: `/folders/${folder}`,
  body: { filter: `tag=${big}&media_type=image` },
})
await bench({
  name: 'watch a folder',
  method: 'PUT',
  path: '/watches',
  body: { target: 'folder', id: folder, every: { count: 1, unit: 'day' } },
})
await bench({
  name: 'tag a post',
  method: 'PATCH',
  path: `/collections/${mediaPosts[0]}/annotation`,
  body: { tag_names: ['bench-small'] },
})
await bench({
  name: 'tag rename',
  method: 'PATCH',
  path: `/tags/${small}`,
  body: { name: 'bench-small' },
})
// Once: these change what they read.
await bench(
  {
    name: 'tag merge, 3,000 into 8,000',
    method: 'PATCH',
    path: `/tags/${small}`,
    body: { name: 'bench-big' },
  },
  1,
)
await bench(
  {
    name: 'media removal, one item',
    method: 'POST',
    path: '/media-removals',
    body: oneAsset,
  },
  1,
)
await bench(
  {
    name: 'media removal, 500 posts',
    method: 'POST',
    path: '/media-removals',
    body: { ids: mediaPosts },
  },
  1,
)
await bench(
  {
    name: 'video removal start',
    method: 'POST',
    path: `/collections/${profile.id}/video-removal`,
  },
  1,
)
await bench(
  {
    name: 'update stop, 8,000 members',
    method: 'POST',
    path: `/captures/${update}/stop`,
  },
  1,
)
await bench(
  {
    name: 'tag delete, on 9,500 posts',
    method: 'DELETE',
    path: `/tags/${big}`,
  },
  1,
)
await bench(
  {
    name: 'delete profile with 3,000 posts',
    method: 'POST',
    path: '/collections/delete',
    body: { ids: [profile.id], with_posts: true },
  },
  1,
)

const header = [
  'what',
  'route',
  'status',
  'response ms',
  'block ms',
  'block max',
]
const widths = header.map((h, i) =>
  Math.max(h.length, ...rows.map((r) => r[i]!.length)),
)
for (const row of [header, ...rows])
  console.log(row.map((cell, i) => cell.padEnd(widths[i]!)).join('  '))
await pool.close()
await queue.stop()
