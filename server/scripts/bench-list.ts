// Seed a library through the real capture pipeline (fake platform), then time
// the collection list for common filters.
//
//   BENCH_AUTHORS=400 node scripts/bench-list.ts seed <db> [posts=20000]
//   node scripts/bench-list.ts run <db> [entity type]
//
// `run` filters on the given root type, by default the most common one in the
// catalog. It fills missing catalog rows first, so point it at a copy of a
// real database, not the live one.
import { Buffer } from 'node:buffer'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { pino } from 'pino'
import { Vault } from '#accounts/vault.ts'
import { FsBlobStore } from '#blob/fs-store.ts'
import { KeyedLock } from '#blob/locks.ts'
import { MediaSigner } from '#blob/signer.ts'
import { isPermanent } from '#capture/errors.ts'
import { captureHandlers } from '#capture/handlers.ts'
import { submit } from '#capture/submit.ts'
import { openDatabase } from '#db/client.ts'
import { JobQueue } from '#jobs/queue.ts'
import { updateAnnotation } from '#library/annotations.ts'
import { catalogMissing } from '#library/catalog.ts'
import { listAuthors, listCollections } from '#library/list.ts'
import { Platforms } from '#platforms/registry.ts'
import { fakePlatform, type FakeFetch } from '#testing/fake-platform.ts'
import { entity, graph, image, JPEG } from '#testing/library.ts'
import type { AccountsContext } from '#accounts/accounts.ts'
import type { CaptureContext } from '#capture/context.ts'
import type { FetchResponse } from '#platforms/protocol.ts'

const [command, file, arg] = process.argv.slice(2)
if (!file || !['seed', 'run'].includes(command ?? '')) {
  console.error('usage: bench-list.ts seed <db> [posts] | run <db> [type]')
  process.exit(2)
}

const AUTHORS = Number(process.env.BENCH_AUTHORS) || 400
const WORDS = [
  '猫',
  '天气',
  'release',
  'photo',
  '旅行',
  'music',
  'code',
  '新闻',
]

/** Deterministic pseudo-random numbers, so runs are comparable. */
function random(seed: number) {
  let state = seed
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    return state / 2_147_483_648
  }
}

function context(fetch: FakeFetch): AccountsContext {
  const db = openDatabase(file!)
  const vault = new Vault(new Uint8Array(32).fill(7))
  const logger = pino({ level: 'silent' })
  const dir = mkdtempSync(path.join(tmpdir(), 'midden-bench-'))
  const signer = new MediaSigner({ secret: new TextEncoder().encode('bench') })
  let ctx: AccountsContext | undefined
  const queue = new JobQueue({
    db,
    logger,
    handlers: captureHandlers(() => ctx!),
    concurrency: { capture: 4, download: 8, control: 4 },
    isPermanent,
  })
  ctx = {
    db,
    queue,
    logger,
    platforms: new Platforms([fakePlatform({ current: fetch })]),
    blobs: new FsBlobStore(path.join(dir, 'media'), signer),
    stagingDir: path.join(dir, 'tmp'),
    vault,
    openCredential: (ref) => vault.open(db, ref),
    mediaLocks: new KeyedLock(),
    fetch: (input) =>
      Promise.resolve(
        new Response(
          Buffer.concat([JPEG, Buffer.from(new URL(String(input)).pathname)]),
        ),
      ),
  }
  return ctx
}

function author(n: number) {
  return entity('author', 'fake.profile', String(n), {
    name: `作者 ${n}`,
    metadata: { protected: n % 10 === 0 },
  })
}

/** Post `n`: by one of the authors, some with media, quotes or reposts. */
function post(n: number): Partial<FetchResponse> {
  const next = random(n + 1)
  const by = Math.floor(next() * AUTHORS)
  const media = Math.floor(next() * 4) - 1
  const resources = Array.from({ length: Math.max(media, 0) }, (_, i) =>
    image(`${n}-${i}.jpg`, { sensitive: next() < 0.05 }),
  )
  const kind = next()
  const entities = [
    entity(
      'root',
      'fake.post',
      String(n),
      {},
      resources.map((_, i) => i),
    ),
    author(by),
  ]
  const relations: [string, string, string][] = [
    ['root', 'authored_by', 'author'],
  ]
  if (kind < 0.1 && n > 10) {
    entities.push(entity('quoted', 'fake.post', String(n - 7)))
    relations.push(['root', 'quoted', 'quoted'])
  } else if (kind < 0.15 && n > 10) {
    entities.push(entity('reposted', 'fake.post', String(n - 3)))
    relations.push(['root', 'reposted', 'reposted'])
  }
  const text = `${WORDS[n % WORDS.length]} post ${n} ${'正文'.repeat(n % 20)}`
  return {
    text,
    authorName: `作者 ${by}`,
    publishedAt: new Date(Date.UTC(2020, 0, 1) + n * 3_600_000).toISOString(),
    resources,
    graph: graph(entities, ...relations),
  }
}

async function seed(ctx: CaptureContext, posts: number) {
  const started = performance.now()
  const batch = 200
  for (let start = 0; start < posts; start += batch) {
    for (let n = start; n < Math.min(start + batch, posts); n++)
      submit(ctx, { url: `https://fake.test/p/${n}` })
    await ctx.queue.drain()
    process.stdout.write(`\r${Math.min(start + batch, posts)} / ${posts}`)
  }
  const tags = ['研究', '收藏'].map((name, i) => {
    const ids = ctx.db.all<{ id: string }>(
      `SELECT collection_id AS id FROM library ORDER BY collection_id LIMIT 300 OFFSET ${i * 300}`,
    )
    let tag = ''
    for (const { id } of ids)
      tag = updateAnnotation(ctx.db, id, { tagNames: [name] }).tags[0]!.id
    return tag
  })
  console.log(
    `\nseeded ${posts} posts in ${((performance.now() - started) / 1000).toFixed(1)}s; tags ${tags.join(', ')}`,
  )
}

function time(label: string, run: () => unknown, times = 5) {
  run()
  const samples: number[] = []
  for (let i = 0; i < times; i++) {
    const at = performance.now()
    run()
    samples.push(performance.now() - at)
  }
  samples.sort((a, b) => a - b)
  console.log(
    `${label.padEnd(36)} median ${samples[Math.floor(times / 2)]!.toFixed(1).padStart(8)} ms`,
  )
}

function bench(ctx: CaptureContext) {
  const tag = ctx.db.get<{ id: string }>('SELECT id FROM tags LIMIT 1')?.id
  const some = ctx.db.get<{ id: string }>(
    'SELECT collection_id AS id FROM library ORDER BY collection_id LIMIT 1',
  )!.id
  const authors = listAuthors(ctx)
  const entityType =
    arg ??
    ctx.db.get<{ kind: string }>(
      'SELECT root_kind AS kind FROM catalog WHERE root_kind IS NOT NULL GROUP BY root_kind ORDER BY count(*) DESC LIMIT 1',
    )?.kind
  if (!entityType) throw new Error('no catalogued collection has a root type')
  console.log(`entity type ${entityType}`)
  const base = { entityType }
  const cases: [string, Parameters<typeof listCollections>[1]][] = [
    ['default', base],
    ['published', { ...base, sort: 'published' }],
    ['storage', { ...base, sort: 'storage' }],
    ['text search', { ...base, q: '天气' }],
    ['rare text', { ...base, q: 'post 1234 ' }],
    ['images', { ...base, mediaType: 'image' }],
    ['text only', { ...base, mediaType: 'text' }],
    ['sensitive', { ...base, sensitive: 'contains' }],
    ['private', { ...base, visibility: 'private' }],
    ['one author', { ...base, authors: [authors[0]!.id] }],
    ['tag', { ...base, tag }],
    ['reposts', { ...base, postType: 'repost' }],
    ['quotes', { ...base, postType: 'quote' }],
    ['related', { relatedTo: some }],
    [
      'combined',
      { ...base, mediaType: 'image', visibility: 'public', sort: 'published' },
    ],
  ]
  for (const [label, filter] of cases) {
    time(label, () => listCollections(ctx, filter))
    const first = listCollections(ctx, filter)
    if (first.next_cursor)
      time(`${label} (page 2)`, () =>
        listCollections(ctx, filter, first.next_cursor),
      )
  }
  time('authors', () => listAuthors(ctx))
}

const ctx = context((req) => post(Number(req.externalId)))
if (command === 'seed') {
  ctx.queue.start()
  await seed(ctx, Number(arg ?? 20_000))
  await ctx.queue.stop()
} else {
  const at = performance.now()
  const added = catalogMissing(ctx.db)
  if (added)
    console.log(
      `catalogued ${added} in ${(performance.now() - at).toFixed(0)} ms`,
    )
  bench(ctx)
}
