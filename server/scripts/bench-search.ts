// Time the library's reads by class, with their query plans, on a copy of a
// real database, so that a change to the list, search or the agent API can
// be compared with what it replaced:
//
//   node scripts/bench-search.ts seed <db>
//   node scripts/bench-search.ts run <db> [out.json] [runs=40]
//   node scripts/bench-search.ts compare <before.json> <after.json>
//   node scripts/bench-search.ts backfill <db>
//
// `seed` adds what a development copy lacks: a dozen folders and follows of
// five accounts (2000 each way, some mutual), once. `run` opens the copy
// (it migrates it, and moves `library_version` between runs so cached
// counts are counted again), times each case `runs` times after a warm-up,
// and records the plan (`EXPLAIN QUERY PLAN`) of every statement a case
// ran. `compare` prints both side by side, flags a class more than 10%
// slower at p50 or p95, and any plan that changed. `backfill` fills the
// facets of every row as maintenance would (`library/facets.ts`), timing
// each batch.
//
// Point it at a copy: `seed` and `run` write to it.
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { runRead } from '#agent/reads.ts'
import { FsBlobStore } from '#blob/fs-store.ts'
import { MediaSigner } from '#blob/signer.ts'
import { openDatabase, type Database } from '#db/client.ts'
import { filterCountsOf } from '#library/counts.ts'
import { backfillBatch } from '#library/facets.ts'
import { createFolder, listFolders } from '#library/folders.ts'
import {
  authorKey,
  countCollections,
  listCollections,
  type CollectionFilter,
} from '#library/list.ts'
import type { AgentReader, Params } from '#agent/query.ts'

const [command, ...args] = process.argv.slice(2)

interface Recorded {
  sql: string
  params: unknown[]
}

/**
 * Every statement the connection runs while `recording` is set, with its
 * parameters, wrapped around `prepare` (Drizzle and the raw client both
 * prepare each statement they run).
 */
function recorder(db: Database) {
  const client = db.$client
  const prepare = client.prepare.bind(client)
  const state: { recording?: Recorded[] } = {}
  client.prepare = ((sql: string) => {
    const statement = prepare(sql)
    for (const method of ['all', 'get', 'run'] as const) {
      const run = statement[method].bind(statement) as (
        ...params: unknown[]
      ) => unknown
      Object.defineProperty(statement, method, {
        configurable: true,
        value: (...params: unknown[]) => {
          state.recording?.push({ sql, params })
          return run(...params)
        },
      })
    }
    return statement
  }) as typeof client.prepare
  return {
    record<T>(fn: () => T): { value: T; statements: Recorded[] } {
      state.recording = []
      try {
        const value = fn()
        return { value, statements: state.recording }
      } finally {
        state.recording = undefined
      }
    },
    plan(statement: Recorded): string[] {
      if (/^\s*(?:begin|commit|rollback|pragma)\b/i.test(statement.sql))
        return []
      const rows = prepare(`EXPLAIN QUERY PLAN ${statement.sql}`).all(
        ...(statement.params as never[]),
      ) as { id: number; parent: number; detail: string }[]
      // Indented by depth, as the sqlite3 shell prints it.
      const depth = new Map<number, number>([[0, -1]])
      return rows.map((row) => {
        const d = (depth.get(row.parent) ?? -1) + 1
        depth.set(row.id, d)
        return `${'  '.repeat(d)}${row.detail}`
      })
    },
  }
}

function seed(file: string) {
  const db = openDatabase(file, { migrate: false })
  const tag = (
    db.$client.prepare('SELECT id FROM tags ORDER BY id').get() as
      { id: string } | undefined
  )?.id
  if (!listFolders(db).length) {
    const filters = [
      'entity_type=x.post',
      'media_type=video',
      'media_type=image&sort=published',
      'media_type=text',
      'sensitive=contains',
      'visibility=private',
      'saved_within=7d',
      'saved_within=30d&media_type=video',
      'post_type=repost',
      'post_type=quote',
      'q=天气',
      'q=release&media_type=image',
      ...(tag ? [`tag=${tag}`, `not_tag=${tag}`] : []),
    ]
    for (const [i, filter] of filters.entries())
      createFolder(db, { name: `folder ${i}`, filter })
    console.info(`created ${filters.length} folders`)
  }
  const edges = db.$client
    .prepare('SELECT count(*) AS n FROM follow_edges')
    .get() as { n: number }
  if (!edges.n) {
    // Five saved accounts follow and are followed by 2000 authors each,
    // a third of them both ways.
    const perspectives = (
      db.$client
        .prepare(
          `SELECT root_entity_id AS id FROM catalog
           WHERE root_kind = 'x.profile' ORDER BY collection_id LIMIT 5`,
        )
        .all() as { id: string }[]
    ).map((row) => row.id)
    const authors = (
      db.$client
        .prepare(
          `SELECT DISTINCT author_entity_id AS id FROM catalog
           WHERE author_entity_id IS NOT NULL ORDER BY author_entity_id`,
        )
        .all() as { id: string }[]
    ).map((row) => row.id)
    const insert = db.$client.prepare(
      `INSERT OR IGNORE INTO follow_edges
        (follower_id, followee_id, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?)`,
    )
    const at = Date.now()
    db.$client.exec('BEGIN IMMEDIATE')
    for (const [p, perspective] of perspectives.entries()) {
      const start = (p * 1300) % authors.length
      const pick = (offset: number) =>
        Array.from(
          { length: 2000 },
          (_, i) => authors[(start + offset + i) % authors.length]!,
        )
      for (const followee of pick(0))
        if (followee !== perspective) insert.run(perspective, followee, at, at)
      for (const follower of pick(1300))
        if (follower !== perspective) insert.run(follower, perspective, at, at)
    }
    db.$client.exec('COMMIT')
    db.$client.exec('ANALYZE follow_edges')
    console.info(`seeded follows of ${perspectives.length} accounts`)
  }
  db.$client.close()
}

interface Case {
  name: string
  /** The class it reports under. */
  group: string
  run: () => unknown
  /** Counted again on every run, as on a changed library. */
  fresh?: boolean
}

interface Result {
  group: string
  n: number
  p50: number
  p95: number
  plans: string[][]
}

function cases(db: Database): Case[] {
  const dir = tmpdir()
  const reader: AgentReader = {
    db,
    blobs: new FsBlobStore(
      dir,
      new MediaSigner({ secret: new TextEncoder().encode('bench') }),
    ),
    types: {
      platforms: ['instagram', 'x'],
      posts: ['instagram.post', 'x.post'],
      accounts: ['instagram.profile', 'x.profile'],
    },
  }
  const one = <T>(sql: string) => db.$client.prepare(sql).get() as T
  const tags = (
    db.$client.prepare('SELECT id, name FROM tags ORDER BY id').all() as {
      id: string
      name: string
    }[]
  ).slice(0, 2)
  const author = one<{ platform: string; kind: string; external: string }>(
    `SELECT e.platform, e.kind, e.external_id AS external FROM catalog k
     JOIN entities e ON e.id = k.author_entity_id
     GROUP BY k.author_entity_id ORDER BY count(*) DESC LIMIT 1`,
  )
  const authors = (
    db.$client
      .prepare(
        `SELECT e.platform, e.kind, e.external_id AS external FROM catalog k
         JOIN entities e ON e.id = k.author_entity_id
         GROUP BY k.author_entity_id ORDER BY count(*) DESC LIMIT 3`,
      )
      .all() as { platform: string; kind: string; external: string }[]
  ).map((a) => authorKey(a))
  const profile = one<{ id: string }>(
    `SELECT k.collection_id AS id FROM catalog k
     JOIN library l ON l.collection_id = k.collection_id
     JOIN catalog p ON p.author_entity_id = k.root_entity_id
     WHERE k.root_kind = 'x.profile'
     GROUP BY k.collection_id ORDER BY count(*) DESC LIMIT 1`,
  )
  const perspectives = (
    db.$client
      .prepare(
        `SELECT e.platform, e.kind, e.external_id AS external
         FROM (SELECT DISTINCT follower_id AS id FROM follow_edges
           GROUP BY follower_id HAVING count(*) > 1000) f
         JOIN entities e ON e.id = f.id ORDER BY e.external_id`,
      )
      .all() as { platform: string; kind: string; external: string }[]
  ).map((a) => authorKey(a))
  const day = 86_400_000
  const newest = one<{ at: number }>(
    'SELECT max(created_at) AS at FROM library',
  ).at
  const iso = (ms: number) => new Date(ms).toISOString()
  const posts = { entityType: 'x.post' }
  const list = (name: string, filter: CollectionFilter): Case => ({
    name,
    group: name.split(' ', 1)[0]!,
    run: () => listCollections(reader, filter),
  })
  const count = (name: string, filter: CollectionFilter): Case => ({
    name,
    group: name.split(' ', 1)[0]!,
    run: () => countCollections(db, filter),
  })
  const agent = (name: string, kind: 'posts' | 'accounts', params: Params) => ({
    name,
    group: 'agent',
    fresh: true,
    run: () => runRead(reader, 'search', { kind, params, origin: 'https://b' }),
  })
  const relOf = perspectives[0]
  return [
    list('list default', posts),
    list('list published', { ...posts, sort: 'published' }),
    list('list saved', { ...posts, sort: 'saved' }),
    list('list saved-asc', { ...posts, sort: 'saved', order: 'asc' }),
    list('list storage', { ...posts, sort: 'storage' }),
    list('list media-image', { ...posts, mediaType: 'image' }),
    list('list media-video', { ...posts, mediaType: 'video' }),
    list('list media-text', { ...posts, mediaType: 'text' }),
    list('list visibility-private', { ...posts, visibility: 'private' }),
    list('list visibility-public', { ...posts, visibility: 'public' }),
    list('list sensitive', { ...posts, sensitive: 'contains' }),
    list('list saved-within', {
      ...posts,
      savedWithin: '30d',
      timeZone: 'Asia/Tokyo',
    }),
    list('list saved-range', {
      ...posts,
      savedFrom: iso(newest - 90 * day),
      savedBefore: iso(newest - 10 * day),
    }),
    list('list author', { ...posts, authors: [authorKey(author)] }),
    list('list authors-3', { ...posts, authors }),
    ...(tags[0]
      ? [
          list('list tag', { ...posts, tag: tags[0].id }),
          list('list not-tag', { ...posts, notTag: tags[0].id }),
        ]
      : []),
    ...(tags[1]
      ? [
          list('list tag-all', {
            ...posts,
            tag: `${tags[0]!.id},${tags[1].id}`,
            tagMode: 'all',
          }),
        ]
      : []),
    list('list related-to', { ...posts, relatedTo: profile.id }),
    list('list post-quote', { ...posts, postType: 'quote' }),
    list('list post-repost', { ...posts, postType: 'repost' }),
    list('list post-original', { ...posts, postType: 'post' }),
    list('list source-state', { ...posts, sourceState: 'deleted' }),
    list('list accounts-followers', {
      entityType: 'x.profile',
      sort: 'followers',
    }),
    count('count default', posts),
    count('count media-video', { ...posts, mediaType: 'video' }),
    count('count visibility-private', { ...posts, visibility: 'private' }),
    ...(tags[0]
      ? [
          count('count tag', { ...posts, tag: tags[0].id }),
          count('count not-tag', { ...posts, notTag: tags[0].id }),
        ]
      : []),
    count('count post-repost', { ...posts, postType: 'repost' }),
    // Search: Latin, CJK and both, a typo (fuzzy), a short word (every
    // row) and nothing found.
    ...(
      [
        ['latin', 'photo'],
        ['latin-2', 'music code'],
        ['latin-fuzzy', 'relaese'],
        ['latin-short', 'ai'],
        ['cjk-1', '猫'],
        ['cjk-2', '天气'],
        ['cjk-4', '正文正文'],
        ['mixed', '猫 photo'],
        ['mixed-2', 'music 正文'],
        ['none', 'zzqqxxyy'],
      ] as const
    ).flatMap(([label, q]) => [
      list(`search ${label}`, { ...posts, q }),
      count(`search-count ${label}`, { ...posts, q }),
    ]),
    list('search published', { ...posts, q: '天气', sort: 'published' }),
    ...(relOf
      ? [
          list('relation following', {
            ...posts,
            relOf: [relOf],
            rel: 'following',
          }),
          list('relation followers', {
            entityType: 'x.profile',
            relOf: [relOf],
            rel: 'followers',
          }),
          list('relation mutual', {
            ...posts,
            relOf: [relOf],
            rel: 'mutual',
          }),
          list('relation multi', {
            ...posts,
            relOf: perspectives,
            rel: 'following',
          }),
          count('relation-count following', {
            ...posts,
            relOf: [relOf],
            rel: 'following',
          }),
          count('relation-count multi', {
            ...posts,
            relOf: perspectives,
            rel: 'following',
          }),
        ]
      : []),
    {
      name: 'folders all',
      group: 'folders',
      fresh: true,
      run: () =>
        filterCountsOf(
          db,
          listFolders(db).map((f) => f.filter),
        ),
    },
    agent('agent newest', 'posts', {}),
    agent('agent q', 'posts', { q: ['猫'] }),
    agent('agent q-latin', 'posts', { q: ['photo'] }),
    agent('agent image', 'posts', { platform: ['x'], media_type: ['image'] }),
    agent('agent author', 'posts', { author: [authorKey(author)] }),
    ...(tags[0] ? [agent('agent tag', 'posts', { tag: [tags[0].name] })] : []),
    agent('agent saved-within', 'posts', {
      saved_within: ['30d'],
      sort: ['published'],
    }),
    agent('agent quote', 'posts', { post_type: ['quote'], size: ['50'] }),
    agent('agent accounts', 'accounts', { sort: ['followers'] }),
    ...(relOf
      ? [agent('agent rel', 'posts', { rel_of: [relOf], rel: ['following'] })]
      : []),
  ]
}

const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!

async function run(file: string, out?: string, runs = 40) {
  const db = openDatabase(file)
  const { record, plan } = recorder(db)
  const bump = db.$client.prepare(
    'UPDATE library_version SET n = n + 1 WHERE id = 1',
  )
  const results: Record<string, Result> = {}
  const started = performance.now()
  // BENCH_SKIP=<regex> leaves cases out (a comparison of a few classes).
  const skip = process.env.BENCH_SKIP
    ? new RegExp(process.env.BENCH_SKIP)
    : undefined
  for (const c of cases(db)) {
    if (skip?.test(c.name)) continue
    const once = async () => {
      if (c.fresh) bump.run()
      const at = performance.now()
      await c.run()
      return performance.now() - at
    }
    // The plans of the warm-up run; the rest only time.
    const { statements } = record(() => {
      if (c.fresh) bump.run()
      return c.run()
    })
    await Promise.resolve()
    await once()
    const samples: number[] = []
    const deadline = performance.now() + 4000
    for (let i = 0; i < runs && performance.now() < deadline; i++)
      samples.push(await once())
    samples.sort((a, b) => a - b)
    const seen = new Set<string>()
    const plans: string[][] = []
    for (const statement of statements) {
      const lines = plan(statement)
      const key = lines.join('\n')
      if (!lines.length || seen.has(key)) continue
      seen.add(key)
      plans.push(lines)
    }
    results[c.name] = {
      group: c.group,
      n: samples.length,
      p50: percentile(samples, 0.5),
      p95: percentile(samples, 0.95),
      plans,
    }
    console.info(
      `${c.name.padEnd(28)} p50 ${results[c.name]!.p50.toFixed(1).padStart(7)} ms  p95 ${results[c.name]!.p95.toFixed(1).padStart(7)} ms  (${samples.length})`,
    )
  }
  console.info(
    `${Object.keys(results).length} cases in ${((performance.now() - started) / 1000).toFixed(0)} s`,
  )
  if (out)
    writeFileSync(
      out,
      `${JSON.stringify({ at: new Date().toISOString(), results }, null, 1)}\n`,
    )
  db.$client.close()
}

function compare(beforeFile: string, afterFile: string) {
  const read = (file: string) =>
    (
      JSON.parse(readFileSync(file, 'utf8')) as {
        results: Record<string, Result>
      }
    ).results
  const before = read(beforeFile)
  const after = read(afterFile)
  let slower = 0
  let changed = 0
  const pct = (a: number, b: number) =>
    `${b >= a ? '+' : ''}${(((b - a) / a) * 100).toFixed(0)}%`.padStart(6)
  for (const [name, b] of Object.entries(before)) {
    const a = after[name]
    if (!a) {
      console.info(`${name.padEnd(28)} missing after`)
      continue
    }
    // Under a millisecond, timer noise is most of a difference.
    const worse = (x: number, y: number) => y > x * 1.1 && y - x > 0.5
    const flag = worse(b.p50, a.p50) || worse(b.p95, a.p95)
    const same =
      JSON.stringify(b.plans) === JSON.stringify(a.plans) ? '' : ' PLAN CHANGED'
    if (flag) slower++
    if (same) changed++
    console.info(
      `${name.padEnd(28)} p50 ${b.p50.toFixed(1).padStart(7)} → ${a.p50.toFixed(1).padStart(7)} ${pct(b.p50, a.p50)}  p95 ${b.p95.toFixed(1).padStart(7)} → ${a.p95.toFixed(1).padStart(7)} ${pct(b.p95, a.p95)}${flag ? '  SLOWER' : ''}${same}`,
    )
    if (same)
      for (const [i, lines] of a.plans.entries())
        if (JSON.stringify(lines) !== JSON.stringify(b.plans[i]))
          console.info(
            `  before:\n    ${(b.plans[i] ?? []).join('\n    ')}\n  after:\n    ${lines.join('\n    ')}`,
          )
  }
  console.info(`${slower} slower, ${changed} with another plan`)
}

function backfill(file: string) {
  const db = openDatabase(file)
  const times: number[] = []
  const started = performance.now()
  for (let more = true; more;) {
    const at = performance.now()
    more = backfillBatch(db)
    times.push(performance.now() - at)
  }
  times.sort((a, b) => a - b)
  const total = performance.now() - started
  const rows = (table: string) =>
    (
      db.$client.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
        n: number
      }
    ).n
  console.info(
    `${times.length} batches in ${(total / 1000).toFixed(1)} s: p50 ${percentile(times, 0.5).toFixed(0)} ms, p95 ${percentile(times, 0.95).toFixed(0)} ms, longest ${times.at(-1)!.toFixed(0)} ms`,
  )
  console.info(
    `hashtags ${rows('post_hashtags')}, mentions ${rows('post_mentions')}, domains ${rows('post_domains')}, with a language ${rows('catalog WHERE lang IS NOT NULL')} of ${rows('catalog')}`,
  )
  db.$client.close()
}

if (command === 'seed' && args[0]) seed(args[0])
else if (command === 'backfill' && args[0]) backfill(args[0])
else if (command === 'run' && args[0])
  await run(args[0], args[1], Number(args[2] ?? 40))
else if (command === 'compare' && args[0] && args[1]) compare(args[0], args[1])
else {
  console.error(
    'usage: bench-search.ts seed <db> | run <db> [out.json] [runs] | compare <before.json> <after.json>',
  )
  process.exit(2)
}
