// Time the agent API's query language and aggregation on a copy of a real
// database, with the plan of each search's main statement:
//
//   node scripts/bench-query.ts <db> [runs=20]
//
// With PLANS=1, the plan of each search's page query is printed too.
// The copy is migrated and its facets filled first (as maintenance would).
// A development copy has few hashtags, mentions and links, so where there
// are fewer than a thousand, synthetic ones are added: a hashtag on every
// third row (200 of them), a mention on every fifth (300 handles), a link
// on every seventh (50 sites). Point it at a copy: it writes to it.
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { runRead } from '#agent/reads.ts'
import { FsBlobStore } from '#blob/fs-store.ts'
import { MediaSigner } from '#blob/signer.ts'
import { openDatabase } from '#db/client.ts'
import { backfillBatch } from '#library/facets.ts'
import { authorKey } from '#library/list.ts'
import { watchStatements } from '#reads/slow.ts'
import type { AgentReader, Params } from '#agent/query.ts'

const [file, runsArg = '20'] = process.argv.slice(2)
if (!file) {
  console.error('usage: bench-query.ts <db> [runs]')
  process.exit(2)
}
const runs = Number(runsArg)
const db = openDatabase(file)
while (backfillBatch(db));
const count = (table: string) =>
  (
    db.$client.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
      n: number
    }
  ).n
if (count('post_hashtags') < 1000) {
  db.$client.exec(`
    BEGIN IMMEDIATE;
    INSERT OR IGNORE INTO post_hashtags (catalog_id, value)
      SELECT id, 'tag' || (id % 200) FROM catalog WHERE id % 3 = 0;
    INSERT OR IGNORE INTO post_mentions (catalog_id, value)
      SELECT id, 'x:user' || (id % 300) FROM catalog WHERE id % 5 = 0;
    INSERT OR IGNORE INTO post_domains (catalog_id, value)
      SELECT id, 'site' || (id % 50) || '.example' FROM catalog WHERE id % 7 = 0;
    COMMIT;
    ANALYZE post_hashtags; ANALYZE post_mentions; ANALYZE post_domains;`)
}
console.info(
  `hashtags ${count('post_hashtags')}, mentions ${count('post_mentions')}, domains ${count('post_domains')}`,
)
watchStatements(db.$client, () => {})

const reader: AgentReader = {
  db,
  blobs: new FsBlobStore(
    '/nonexistent',
    new MediaSigner({ secret: new TextEncoder().encode('bench') }),
  ),
  types: {
    platforms: ['instagram', 'x'],
    posts: ['instagram.post', 'x.post'],
    accounts: ['instagram.profile', 'x.profile'],
  },
}
const author = authorKey(
  db.$client
    .prepare(
      `SELECT e.platform, e.kind, e.external_id AS external FROM catalog k
       JOIN entities e ON e.id = k.author_entity_id
       GROUP BY k.author_entity_id ORDER BY count(*) DESC LIMIT 1`,
    )
    .get() as { platform: string; kind: string; external: string },
)
const perspective = db.$client
  .prepare(
    `SELECT e.platform, e.kind, e.external_id AS external FROM follow_edges f
     JOIN entities e ON e.id = f.follower_id
     GROUP BY f.follower_id ORDER BY count(*) DESC LIMIT 1`,
  )
  .get() as { platform: string; kind: string; external: string } | undefined

// The account whose timeline lists the most reposts.
const reposter = db.$client
  .prepare(
    `SELECT e.platform, e.kind, e.external_id AS external
     FROM entity_relations edge
     JOIN revision_entities src ON src.revision_id = edge.revision_id
       AND src.entity_key = edge.source_key AND src.is_root = 1
     JOIN entity_versions v ON v.id = src.entity_version_id
     JOIN entities e ON e.id = v.entity_id
     WHERE edge.kind = 'reposted' AND e.kind LIKE '%.profile'
     GROUP BY e.id ORDER BY count(*) DESC LIMIT 1`,
  )
  .get() as { platform: string; kind: string; external: string } | undefined

const searches: string[] = [
  '#tag7',
  '#tag7 OR #tag8 OR #tag9',
  'mentions:@user5',
  'domain:site3.example',
  'lang:ja',
  'lang:zh has:image',
  'has:link',
  `from:${author}`,
  `from:${author} -has:image`,
  '猫 -#tag1 since:2020-01-01',
  '(music OR code) has:image',
  'is:quote -has:video',
  'folder:"folder 1" #tag3',
  '"post 1"',
  'within:30d',
  '#tag7 lang:zh type:post',
  '-#tag1 -#tag2 saved:30d',
  ...(reposter ? [`reposted-by:${authorKey(reposter)}`] : []),
  ...(perspective
    ? [`rel:following:${authorKey(perspective)} (#tag1 OR mentions:@user1)`]
    : []),
]
const aggregates: Params[] = [
  { by: ['month'] },
  { by: ['author'], q: ['type:post'] },
  { by: ['hashtag'] },
  { by: ['lang'] },
  { by: ['type'] },
  { by: ['domain'], q: ['has:link'] },
  { by: ['day'], tz: ['Asia/Tokyo'], q: ['#tag7'] },
  { by: ['weekday'], tz: ['Asia/Tokyo'], q: ['lang:zh'] },
]

const bump = db.$client.prepare(
  'UPDATE library_version SET n = n + 1 WHERE id = 1',
)
const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!

async function time(label: string, fn: () => unknown) {
  bump.run()
  await fn()
  const samples: number[] = []
  const deadline = performance.now() + 4000
  for (let i = 0; i < runs && performance.now() < deadline; i++) {
    bump.run()
    const at = performance.now()
    await fn()
    samples.push(performance.now() - at)
  }
  samples.sort((a, b) => a - b)
  console.info(
    `${label.slice(0, 60).padEnd(60)} p50 ${percentile(samples, 0.5).toFixed(1).padStart(7)} ms  p95 ${percentile(samples, 0.95).toFixed(1).padStart(7)} ms`,
  )
}

/** The plan of the statement that reads a page (the one with LIMIT). */
function pagePlan(fn: () => unknown): string {
  const client = db.$client
  const prepare = client.prepare
  let page: { sql: string; params: unknown[] } | undefined
  client.prepare = ((sql: string) => {
    const statement = prepare.call(client, sql)
    const all = statement.all.bind(statement)
    Object.defineProperty(statement, 'all', {
      configurable: true,
      value: (...params: unknown[]) => {
        if (/LIMIT \?\s*$/.test(sql)) page = { sql, params }
        return all(...(params as never[]))
      },
    })
    return statement
  }) as typeof client.prepare
  try {
    fn()
  } finally {
    client.prepare = prepare
  }
  if (!page) return ''
  return (
    client
      .prepare(`EXPLAIN QUERY PLAN ${page.sql}`)
      .all(...(page.params as never[])) as { detail: string }[]
  )
    .map((row) => `    ${row.detail}`)
    .join('\n')
}

for (const q of searches) {
  const result = (await runRead(reader, 'search', {
    kind: 'posts',
    params: { q: [q] },
    origin: 'https://b',
  })) as { total: number }
  if (process.env.PLANS)
    console.info(
      pagePlan(() =>
        runRead(reader, 'search', {
          kind: 'posts',
          params: { q: [q] },
          origin: 'https://b',
        }),
      ),
    )
  await time(`posts q=${q} (${result.total})`, () =>
    runRead(reader, 'search', {
      kind: 'posts',
      params: { q: [q] },
      origin: 'https://b',
    }),
  )
}
for (const params of aggregates) {
  const label = `aggregate ${new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, v[0]!]),
  ).toString()}`
  await time(decodeURIComponent(label), () =>
    runRead(reader, 'aggregate', { params }),
  )
}
db.$client.close()
