// Replay update churn through the real capture pipeline (fake platform) on a
// copy of a database, then report how full the pages of `captures` and the
// tables beside it are: rows that grow after their page filled split it,
// and staged bulk that goes away leaves it half empty.
//
//   node scripts/bench-churn.ts <copy.db> [profiles=150]
//
// Each profile is updated twice; every update reads two timeline pages of 20
// posts, each listed with a prefetch, and fetches every post again. Sizes
// follow production: payloads of a few KB, raw responses of ~5.7 KB.
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
import { resolveOptions } from '#capture/options.ts'
import { submit } from '#capture/submit.ts'
import { openDatabase } from '#db/client.ts'
import { JobQueue } from '#jobs/queue.ts'
import { Platforms } from '#platforms/registry.ts'
import { fakePlatform, postGraph } from '#testing/fake-platform.ts'
import type { AccountsContext } from '#accounts/accounts.ts'
import type { FetchRequest, FetchResponse } from '#platforms/protocol.ts'

const [file, arg] = process.argv.slice(2)
if (!file) {
  console.error('usage: bench-churn.ts <copy.db> [profiles]')
  process.exit(2)
}
const PROFILES = Number(arg ?? 150)
const PAGE = 20

/** Deterministic pseudo-random numbers, so runs are comparable. */
function random(seed: number) {
  let state = seed
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    return state / 2_147_483_648
  }
}

/** JSON text of about `size` bytes that compresses like API responses. */
function json(next: () => number, size: number): string {
  const items: string[] = []
  let length = 0
  while (length < size) {
    const item = `{"id":"${Math.floor(next() * 1e15)}","text":"${next().toString(36).repeat(3)}","likes":${Math.floor(next() * 1e5)}}`
    items.push(item)
    length += item.length + 1
  }
  return `[${items.join(',')}]`
}

let fetches = 0
function respond(req: FetchRequest): Partial<FetchResponse> {
  const next = random(++fetches)
  const source = {
    body: Buffer.from(json(next, 2000 + next() * 7000)),
    contentType: 'application/json',
    sourceUrl: 'https://api.test/graphql',
    visibility: 1,
  }
  if (req.kind === 'post')
    return {
      text: json(next, 1500 + next() * 4000),
      graph: postGraph(req.externalId, { likes: Math.floor(next() * 1e4) }),
      sourceResponses: [source],
    }
  // A profile timeline page: posts `<profile>-<page>-<n>` with prefetches.
  const page = Number(req.pageCursor || 0)
  const handle = req.externalId.replace('handle:', '')
  return {
    text: json(next, 3000 + next() * 5000),
    relatedTargets: Array.from({ length: PAGE }, (_, i) => ({
      url: `https://fake.test/p/${handle.slice(1)}${page}${String(i).padStart(2, '0')}`,
      // Fetched again on the second update.
      refreshAfterSeconds: 1,
      updatedAt: '',
      publishedAt: new Date(
        Date.UTC(2026, 0, 1) - page * 86_400_000,
      ).toISOString(),
      mediaTypes: [],
      postType: 'post',
      prefetch: Buffer.from(json(next, 3000 + next() * 4000)),
      listedAt: '',
      pinned: false,
    })),
    nextPageCursor: page < 1 ? String(page + 1) : '',
    sourceResponses: [source],
  }
}

function context(): AccountsContext {
  const db = openDatabase(file!)
  const vault = new Vault(new Uint8Array(32).fill(7))
  const logger = pino({ level: 'silent' })
  const dir = mkdtempSync(path.join(tmpdir(), 'midden-churn-'))
  const signer = new MediaSigner({ secret: new TextEncoder().encode('bench') })
  let ctx: AccountsContext | undefined
  const queue = new JobQueue({
    db,
    logger,
    handlers: captureHandlers(() => ctx!),
    concurrency: { capture: 4, download: 8, control: 4, upload: 4, raw: 4 },
    isPermanent,
  })
  ctx = {
    db,
    queue,
    logger,
    platforms: new Platforms([fakePlatform({ current: respond })]),
    blobs: new FsBlobStore(path.join(dir, 'media'), signer),
    stagingDir: path.join(dir, 'tmp'),
    vault,
    openCredential: (ref) => vault.open(db, ref),
    mediaLocks: new KeyedLock(),
  }
  return ctx
}

const TABLES = [
  'captures',
  'capture_targets',
  'capture_metrics',
  'capture_staging',
  'source_responses',
]

function report(ctx: AccountsContext, label: string) {
  const rows = ctx.db.$client
    .prepare(
      `SELECT name, count(*) AS pages,
        sum(pagetype = 'overflow') AS overflow,
        sum(CASE WHEN pagetype = 'leaf' THEN unused END) AS free,
        sum(CASE WHEN pagetype = 'leaf' THEN pgsize END) AS leaf,
        sum(payload) AS data
      FROM dbstat WHERE name IN (${TABLES.map((t) => `'${t}'`).join(', ')})
      GROUP BY name`,
    )
    .all() as {
    name: string
    pages: number
    overflow: number
    free: number
    leaf: number
    data: number
  }[]
  const pageSize = (
    ctx.db.$client.prepare('PRAGMA page_size').get() as { page_size: number }
  ).page_size
  const mb = (bytes: number) => `${(bytes / 2 ** 20).toFixed(1)} MB`
  console.log(label)
  for (const row of rows.toSorted(
    (a, b) => TABLES.indexOf(a.name) - TABLES.indexOf(b.name),
  ))
    console.log(
      `  ${row.name.padEnd(17)} ${mb(row.pages * pageSize).padStart(9)}  data ${mb(row.data).padStart(9)}  leaf pages ${String(row.pages - row.overflow).padStart(6)}, ${((100 * row.free) / Math.max(row.leaf, 1)).toFixed(1).padStart(5)}% free`,
    )
}

const ctx = context()
report(ctx, 'before')
ctx.queue.start()
const started = performance.now()
const options = resolveOptions({ count: 2 * PAGE })
for (let round = 0; round < 2; round++)
  for (let start = 0; start < PROFILES; start += 10) {
    for (let p = start; p < Math.min(start + 10, PROFILES); p++)
      submit(ctx, { url: `https://fake.test/u/b${1000 + p}`, options })
    await ctx.queue.drain()
  }
await ctx.queue.stop()
console.log(
  `${fetches} fetches in ${((performance.now() - started) / 1000).toFixed(1)} s`,
)
report(ctx, 'after')
ctx.db.$client.close()
