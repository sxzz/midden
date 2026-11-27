// The query language against a small archive captured through the real
// pipeline: random queries compared with an evaluator that reads the same
// archive the plain way, the plans each kind of term gets, and queries the
// list's filter can say running as that filter does.
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { aggregate } from '#agent/aggregate.ts'
import { readSearch, type AgentReader } from '#agent/query.ts'
import { typeCatalog } from '#agent/runner.ts'
import { detectLang, langMatches } from '#lang/detect.ts'
import { updateAnnotation } from '#library/annotations.ts'
import { domainsOf, hashtagsOf } from '#library/facets.ts'
import { filterString, parseFilterQuery } from '#library/filter-query.ts'
import {
  folderFilter,
  folderSelection,
  storedQuery,
} from '#library/folder-query.ts'
import { createFolder, updateFolder } from '#library/folders.ts'
import {
  countCollections,
  listCollections,
  savedSince,
  wholeSelection,
  type CollectionFilter,
  type QueryExtra,
} from '#library/list.ts'
import { fold } from '#library/search-text.ts'
import {
  capture,
  entity,
  graph,
  image,
  libraryContext,
} from '#testing/library.ts'
import { SYSTEM } from '#users/principal.ts'
import { parseQuery, QueryError, type Leaf, type QueryNode } from './ast.ts'
import { compileQuery, type CompileOptions } from './compile.ts'
import { filterToQuery, wordTerm } from './convert.ts'
import type { CaptureContext } from '#capture/context.ts'
import type { FetchResponse } from '#platforms/protocol.ts'

/** Deterministic pseudo-random numbers. */
function random(seed: number) {
  let state = seed
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    return state / 2_147_483_648
  }
}

const ACCOUNTS = {
  '1': {
    username: 'alice',
    name: 'Alice',
    bio: 'Alice draws #cats at https://alice.test',
  },
  '2': { username: 'bob', name: 'Bob', bio: '今日も猫の絵を描きます' },
  '3': { username: 'carol', name: 'Carol', bio: 'carol walks dogs' },
} as const
type Handle = (typeof ACCOUNTS)[keyof typeof ACCOUNTS]['username']

/** Words of three letters and single CJK characters: no fuzzy tier. */
const WORDS = ['cat', 'dog', 'sun', 'sky', 'tea', '猫', '犬', '空']
const SNIPPETS = [
  'the cat and the dog',
  'a sky of tea',
  '今日は猫の日です',
  '今天天气很好 犬',
  '今天天氣很好',
  'el sol y la luna',
  'sun sun sun',
]

interface Post {
  id: string
  author: '1' | '2' | '3'
  text: string
  mentions: Handle[]
  image: boolean
  video: boolean
  sensitive: boolean
  quotes?: string
  reposts?: string
  published: string
}

function posts(): Post[] {
  const next = random(11)
  const pick = <T>(list: readonly T[]) =>
    list[Math.floor(next() * list.length)]!
  return Array.from({ length: 30 }, (_, i) => {
    const parts = [pick(SNIPPETS), pick(WORDS)]
    if (next() < 0.4) parts.push(`#${pick(['Cats', 'dogs', '猫', 'sun'])}`)
    if (next() < 0.3)
      parts.push(
        `https://${pick(['a.test', 'www.b.test', 'music.a.test'])}/x${i}`,
      )
    const mentions =
      next() < 0.3 ? [pick(['alice', 'bob', 'carol'] as const)] : []
    for (const m of mentions) parts.push(`@${m}`)
    return {
      id: `p${i}`,
      author: pick(['1', '2', '3'] as const),
      text: parts.join(' '),
      mentions,
      image: next() < 0.4,
      video: next() < 0.15,
      sensitive: next() < 0.15,
      // A post quotes or reposts at most one other, an earlier one.
      ...(i > 3 && next() < 0.35
        ? next() < 0.55
          ? { quotes: `p${Math.floor(next() * i)}` }
          : { reposts: `p${Math.floor(next() * i)}` }
        : {}),
      published: new Date(
        Date.UTC(2026, 0, 1) + i * 5 * 86_400_000,
      ).toISOString(),
    }
  })
}

const POSTS = posts()

function route(id: string): Partial<FetchResponse> {
  const account = ACCOUNTS[id as keyof typeof ACCOUNTS]
  if (account) {
    const reposted = TIMELINE_REPOSTS[id]
    const response: Partial<FetchResponse> = {
      text: account.name,
      graph: graph(
        [
          entity('root', 'fake.profile', id, {
            username: account.username,
            name: account.name,
            metadata: { description: account.bio },
          }),
          ...(reposted
            ? [entity('reposted', 'fake.post', reposted, { text: '' })]
            : []),
        ],
        ...(reposted
          ? [['root', 'reposted', 'reposted'] as [string, string, string]]
          : []),
      ),
    }
    return response
  }
  const post = POSTS.find((p) => p.id === id)!
  const author = ACCOUNTS[post.author]
  const resources = [
    ...(post.image ? [image(`${id}.jpg`, { sensitive: post.sensitive })] : []),
    ...(post.video
      ? [
          {
            ...image(`${id}.mp4`, { sensitive: post.sensitive }),
            kind: 'video',
          },
        ]
      : []),
  ]
  const entities = [
    entity(
      'root',
      'fake.post',
      id,
      { text: post.text },
      resources.map((_, i) => i),
    ),
    entity('author', 'fake.profile', post.author, {
      username: author.username,
      name: author.name,
    }),
    ...post.mentions.map((m) =>
      entity(`m_${m}`, 'fake.profile', `handle:${m}`, { username: m }),
    ),
    ...(post.quotes
      ? [entity('quoted', 'fake.post', post.quotes, { text: '' })]
      : []),
    ...(post.reposts
      ? [entity('reposted', 'fake.post', post.reposts, { text: '' })]
      : []),
  ]
  const relations: [string, string, string][] = [
    ['root', 'authored_by', 'author'],
    ...post.mentions.map(
      (m) => ['root', 'mentions', `m_${m}`] as [string, string, string],
    ),
    ...(post.quotes
      ? [['root', 'quoted', 'quoted'] as [string, string, string]]
      : []),
    ...(post.reposts
      ? [['root', 'reposted', 'reposted'] as [string, string, string]]
      : []),
  ]
  return {
    text: post.text,
    authorName: author.name,
    publishedAt: post.published,
    resources,
    graph: graph(entities, ...relations),
  }
}

let ctx: CaptureContext
let reader: AgentReader
const ids: Record<string, string> = {}
/** Reposts an account's timeline lists, by account. */
const TIMELINE_REPOSTS: Partial<Record<string, string>> = { '3': 'p0' }
const DELETED = new Set(['p5', 'p17'])
const FOLLOWS: [Handle, Handle][] = [
  ['alice', 'bob'],
  ['alice', 'carol'],
  ['carol', 'alice'],
]

beforeAll(async () => {
  ;({ ctx } = libraryContext((req) => route(req.externalId)))
  for (const id of ['1', '2', '3'])
    ids[id] = (await capture(ctx, `https://fake.test/u/${id}`)).collectionId
  // Quoted and reposted posts first, so they are saved when quoted.
  for (const post of POSTS)
    ids[post.id] = (
      await capture(ctx, `https://fake.test/p/${post.id}`)
    ).collectionId
  updateAnnotation(ctx.db, ids['2']!, { tagNames: ['blue'] })
  for (const id of ['p1', 'p2', 'p9', 'p20'])
    updateAnnotation(ctx.db, ids[id]!, { tagNames: ['red'] })
  for (const id of DELETED)
    ctx.db.run(
      sql`UPDATE collections SET source_state = 'deleted' WHERE id = ${ids[id]!}`,
    )
  const entityOf = (handle: Handle) =>
    ctx.db.get<{ id: string }>(sql`
      SELECT root_entity_id AS id FROM catalog WHERE collection_id = ${
        ids[
          Object.entries(ACCOUNTS).find(([, a]) => a.username === handle)![0]
        ]!
      }`)!.id
  for (const [a, b] of FOLLOWS)
    ctx.db
      .run(sql`INSERT INTO follow_edges (follower_id, followee_id, first_seen_at, last_seen_at)
      VALUES (${entityOf(a)}, ${entityOf(b)}, 1, 1)`)
  createFolder(ctx.db, { name: 'imgs', filter: 'media_type=image' })
  ctx.db.$client.exec('ANALYZE')
  reader = {
    db: ctx.db,
    blobs: ctx.blobs,
    types: typeCatalog(ctx.platforms),
    principal: SYSTEM,
  }
})

afterAll(async () => {
  await ctx.queue.stop()
})

// --- The evaluator ---------------------------------------------------------

interface Row {
  id: string
  name: string
  profile: boolean
  author?: Handle
  subject: Handle
  /** Search columns, as the catalog builds them. */
  columns: string[]
  hashtags: string[]
  mentions: string[]
  domains: string[]
  lang: string | null
  image: boolean
  video: boolean
  sensitive: boolean
  type: 'original' | 'quote' | 'repost'
  quotes?: string
  reposts?: string
  /** Who reposted it: by a post of theirs or on their timeline. */
  repostedBy: Handle[]
  published: number
  saved: number
  tags: string[]
  state?: string
}

function rows(): Row[] {
  const times = new Map(
    ctx.db
      .all<{ id: string; published: number; saved: number }>(
        sql`
        SELECT k.collection_id AS id, k.published_at AS published, l.created_at AS saved
        FROM catalog k JOIN library l ON l.collection_id = k.collection_id`,
      )
      .map((r) => [r.id, r]),
  )
  const repostedBy = new Map<string, Handle[]>()
  const repost = (post: string, by: Handle) =>
    repostedBy.set(post, [...(repostedBy.get(post) ?? []), by])
  for (const p of POSTS)
    if (p.reposts) repost(p.reposts, ACCOUNTS[p.author].username)
  for (const [id, post] of Object.entries(TIMELINE_REPOSTS))
    repost(post!, ACCOUNTS[id as keyof typeof ACCOUNTS].username)
  const nameOf = (a: (typeof ACCOUNTS)[keyof typeof ACCOUNTS]) =>
    `${fold(a.name)}\n@${a.username}`
  const out: Row[] = []
  for (const [id, account] of Object.entries(ACCOUNTS)) {
    const t = times.get(ids[id]!)!
    out.push({
      id,
      name: id,
      profile: true,
      subject: account.username,
      columns: [nameOf(account), '', '', fold(account.bio)],
      hashtags: hashtagsOf(account.bio),
      mentions: [],
      domains: domainsOf(account.bio),
      lang: detectLang(account.bio).lang,
      image: false,
      video: false,
      sensitive: false,
      type: 'original',
      ...(TIMELINE_REPOSTS[id] ? { reposts: TIMELINE_REPOSTS[id] } : {}),
      repostedBy: [],
      published: t.published,
      saved: t.saved,
      tags: id === '2' ? ['blue'] : [],
    })
  }
  for (const post of POSTS) {
    const t = times.get(ids[post.id]!)!
    const author = ACCOUNTS[post.author]
    const pointed = post.quotes ?? post.reposts
    const target = pointed ? POSTS.find((p) => p.id === pointed) : undefined
    out.push({
      id: post.id,
      name: post.id,
      profile: false,
      author: author.username,
      subject: author.username,
      columns: [
        nameOf(author),
        fold(post.text),
        target
          ? fold(`${nameOf(ACCOUNTS[target.author])} ${fold(target.text)}`)
          : '',
        '',
      ],
      hashtags: hashtagsOf(post.text),
      mentions: post.mentions.map((m) => `fake:${m}`),
      domains: domainsOf(post.text),
      lang: detectLang(post.text).lang,
      image: post.image,
      video: post.video,
      sensitive: post.sensitive && (post.image || post.video),
      type: repostedBy.has(post.id)
        ? 'repost'
        : post.quotes
          ? 'quote'
          : 'original',
      ...(post.quotes ? { quotes: post.quotes } : {}),
      ...(post.reposts ? { reposts: post.reposts } : {}),
      repostedBy: repostedBy.get(post.id) ?? [],
      published: t.published,
      saved: t.saved,
      tags: [
        ...(['p1', 'p2', 'p9', 'p20'].includes(post.id) ? ['red'] : []),
        ...(post.author === '2' ? ['blue'] : []),
      ],
      ...(DELETED.has(post.id) ? { state: 'deleted' } : {}),
    })
  }
  return out
}

const dayStart = (date: string) =>
  Temporal.PlainDate.from(date).toZonedDateTime('UTC').epochMilliseconds

function handleOf(value: string) {
  return value.replace(/^[a-z]+:/, '').replace(/^@/, '')
}

function matches(row: Row, node: QueryNode, all: Row[]): boolean {
  switch (node.type) {
    case 'and':
      return node.items.every((i) => matches(row, i, all))
    case 'or':
      return node.items.some((i) => matches(row, i, all))
    case 'not':
      return !matches(row, node.item, all)
    case 'word':
      return fold(node.value)
        .split(' ')
        .every((t) => row.columns.some((c) => c.includes(t)))
    case 'phrase':
      return row.columns.some((c) => c.includes(fold(node.value)))
    case 'hashtag':
      return row.hashtags.includes(node.value)
  }
  const leaf = node as Extract<Leaf, { type: 'atom' }>
  const v = leaf.value
  const byAuthor = (h: string) =>
    all.filter((r) => !r.profile && r.author === h).map((r) => r.id)
  switch (leaf.key) {
    case 'from':
      return row.author === handleOf(v)
    case 'mentions':
      return row.mentions.includes(`fake:${handleOf(v)}`)
    case 'domain':
      return row.domains.includes(v)
    case 'lang':
      return row.lang !== null && langMatches(row.lang, v)
    case 'has':
      return v === 'link'
        ? row.domains.length > 0
        : v === 'media'
          ? row.image || row.video
          : v === 'image'
            ? row.image
            : row.video
    case 'platform':
      return v === 'fake'
    case 'type': {
      const profile = v === 'profile'
      return row.profile === profile
    }
    case 'protected':
      // No account here says whether it is protected.
      return false
    case 'related':
      throw new Error('related: is not generated')
    case 'sensitive': {
      const yes = v === 'yes'
      return row.sensitive === yes
    }
    case 'is':
      return row.type === v
    case 'state':
      return row.state === v
    case 'tag':
      return row.tags.includes(v)
    case 'since':
      return row.published >= dayStart(v)
    case 'until':
      return row.published < dayStart(v)
    case 'within':
      return row.published >= savedSince(v, 'UTC')!
    case 'saved':
      return /^\d{4}/.test(v)
        ? row.saved >= dayStart(v) && row.saved < dayStart(v) + 86_400_000
        : row.saved >= savedSince(v, 'UTC')!
    case 'saved-since':
      return row.saved >= dayStart(v)
    case 'saved-until':
      return row.saved < dayStart(v)
    case 'folder':
      return row.image
    case 'rel': {
      const [set, ref] = v.split(':', 2)
      const of = handleOf(ref!)
      const following = FOLLOWS.some(([a, b]) => a === of && b === row.subject)
      const follower = FOLLOWS.some(([a, b]) => b === of && a === row.subject)
      return set === 'following'
        ? following
        : set === 'followers'
          ? follower
          : following && follower
    }
    case 'reposted-by':
      return row.repostedBy.includes(handleOf(v) as Handle)
    case 'quotes':
    case 'reposts': {
      const pointed = leaf.key === 'quotes' ? row.quotes : row.reposts
      if (!pointed) return false
      const targets = v.startsWith('@') ? byAuthor(handleOf(v)) : [v]
      return targets.includes(pointed)
    }
  }
}

// --- Random queries ------------------------------------------------------------

function leafText(next: () => number, ref: (id: string) => string): string {
  const pick = <T>(list: readonly T[]) =>
    list[Math.floor(next() * list.length)]!
  const post = () => pick(POSTS).id
  return pick([
    () => pick(WORDS),
    () => `"${pick(['the cat', 'sun sun', '猫の'])}"`,
    () => `#${pick(['cats', 'dogs', '猫', 'sun', 'none'])}`,
    () => `from:@${pick(['alice', 'bob', 'carol', 'nobody'])}`,
    () => `mentions:@${pick(['alice', 'bob', 'carol'])}`,
    () => `domain:${pick(['a.test', 'b.test', 'alice.test'])}`,
    () => `lang:${pick(['ja', 'zh', 'zh-Hans', 'en', 'es'])}`,
    () => `has:${pick(['image', 'video', 'media', 'link'])}`,
    () => `is:${pick(['original', 'quote', 'repost'])}`,
    () => `type:${pick(['post', 'profile'])}`,
    () => `sensitive:${pick(['yes', 'no'])}`,
    () => 'state:deleted',
    () => `tag:${pick(['red', 'blue'])}`,
    () => `since:2026-0${1 + Math.floor(next() * 5)}-01`,
    () => `until:2026-0${1 + Math.floor(next() * 5)}-15`,
    () => pick(['within:30d', 'within:3650d', 'saved:7d', 'saved:2020-01-01']),
    () => pick(['saved-since:2020-01-01', 'saved-until:2020-01-01']),
    () => 'platform:fake',
    () => 'folder:imgs',
    () =>
      `rel:${pick(['following', 'followers', 'mutual'])}:@${pick(['alice', 'carol'])}`,
    () => `quotes:${pick([ref(post()), '@alice', '@bob'])}`,
    () => `reposts:${pick([ref(post()), '@carol'])}`,
    () => `reposted-by:@${pick(['alice', 'bob', 'carol', 'nobody'])}`,
  ])()
}

/** A random query, terms nested up to two deep. */
function randomQuery(next: () => number, ref: (id: string) => string): string {
  const term = (depth: number): string => {
    const roll = next()
    if (depth >= 2 || roll < 0.5) {
      const leaf = leafText(next, ref)
      return next() < 0.25 ? `-${leaf}` : leaf
    }
    const items = Array.from({ length: 2 + Math.floor(next() * 2) }, () =>
      term(depth + 1),
    )
    return `(${items.join(roll < 0.75 ? ' ' : ' OR ')})`
  }
  return Array.from({ length: 1 + Math.floor(next() * 3) }, () => term(0)).join(
    ' ',
  )
}

/**
 * The search terms of the top level, which run as the ranked keyword
 * search: more than two would make three trigram units and let the fuzzy
 * tier in, which adds near misses on purpose.
 */
function rankedTerms(node: QueryNode): number {
  const items = node.type === 'and' ? node.items : [node]
  return items
    .filter((i) => i.type === 'word' || i.type === 'phrase')
    .flatMap((i) => fold((i as Leaf).value).split(' ')).length
}

describe('random queries', () => {
  test('select what an evaluator over the same archive selects', () => {
    const all = rows()
    const ref = (post: string) => ids[post]!
    const byCollection = new Map(all.map((r) => [ids[r.id]!, r] as const))
    const next = random(3)
    let checked = 0
    let nonEmpty = 0
    for (let i = 0; i < 400; i++) {
      let text = randomQuery(next, ref)
      for (;;) {
        try {
          if (rankedTerms(parseQuery(text)!) <= 2) break
        } catch {
          break
        }
        text = randomQuery(next, ref)
      }
      const options: CompileOptions = {
        db: ctx.db,
        types: reader.types,
        kind: 'all',
        filter: {},
        scoped: true,
      }
      let compiled
      try {
        compiled = compileQuery(text, options)
      } catch (error) {
        if (error instanceof QueryError && /at most|deep/i.test(error.message))
          continue
        throw new Error(`${text}: ${String(error)}`, { cause: error })
      }
      if (!compiled) continue
      const base = compiled.filter
      const narrow = undefined
      const { ctes, source, where } = wholeSelection(
        ctx.db,
        base,
        narrow,
        compiled.extra,
      )
      const got = ctx.db
        .all<{ id: string }>(
          sql`${ctes} SELECT k.collection_id AS id
          FROM ${sql.raw(source)} WHERE ${where}`,
        )
        .map((r) => byCollection.get(r.id)!.id)
        .toSorted()
      // `node` is the query with its values canonical; ids stand for posts.
      const resolved = JSON.parse(
        JSON.stringify(compiled.node).replaceAll(
          /"value":"([\da-f-]{36})"/g,
          (_, id: string) => `"value":"${byCollection.get(id)?.id ?? id}"`,
        ),
      ) as QueryNode
      const expected = all
        .filter((row) => matches(row, resolved, all))
        .map((r) => r.id)
        .toSorted()
      expect(got, `${text} → ${compiled.parsed}`).toEqual(expected)
      expect(countCollections(ctx.db, base, narrow, compiled.extra).count).toBe(
        expected.length,
      )
      const page = listCollections(
        reader,
        base,
        undefined,
        narrow,
        50,
        compiled.extra,
      )
      expect(
        page.items.map((c) => byCollection.get(c.id)!.id).toSorted(),
      ).toEqual(expected)
      checked++
      if (expected.length) nonEmpty++
    }
    expect(checked).toBeGreaterThan(300)
    expect(nonEmpty).toBeGreaterThan(60)
  })
})

// --- Plans -----------------------------------------------------------------

/** The plan of every statement the whole selection of a query runs. */
function plan(text: string): string {
  const compiled = compileQuery(text, {
    db: ctx.db,
    types: reader.types,
    kind: 'posts',
    filter: { entityType: reader.types.posts.join(',') },
    scoped: true,
  })!
  const { ctes, source, where } = wholeSelection(
    ctx.db,
    compiled.filter,
    undefined,
    compiled.extra,
  )
  const client = ctx.db.$client
  const prepare = client.prepare
  const ran: { sql: string; params: unknown[] }[] = []
  client.prepare = ((query: string) => {
    const statement = prepare.call(client, query)
    const all = statement.all.bind(statement)
    Object.defineProperty(statement, 'all', {
      configurable: true,
      value: (...params: unknown[]) => {
        ran.push({ sql: query, params })
        return all(...(params as never[]))
      },
    })
    return statement
  }) as typeof client.prepare
  try {
    ctx.db.all(sql`${ctes}
      SELECT k.collection_id FROM ${sql.raw(source)} WHERE ${where}`)
  } finally {
    client.prepare = prepare
  }
  const last = ran.at(-1)!
  return (
    client
      .prepare(`EXPLAIN QUERY PLAN ${last.sql}`)
      .all(...(last.params as never[])) as { detail: string }[]
  )
    .map((r) => r.detail)
    .join('\n')
}

describe('languages', () => {
  const langs = () => {
    const counts: Record<string, number> = {}
    for (const row of rows()) {
      const key = row.lang ?? 'und'
      counts[key] = (counts[key] ?? 0) + 1
    }
    return counts
  }

  test('lang: takes a language with its scripts, or one script', () => {
    const counts = langs()
    // The archive has Chinese of both scripts, and Japanese.
    expect(counts['zh-Hans']).toBeGreaterThan(0)
    expect(counts['zh-Hant']).toBeGreaterThan(0)
    expect(counts.ja).toBeGreaterThan(0)
    const total = (q: string) => {
      const compiled = compileQuery(q, {
        db: ctx.db,
        types: reader.types,
        kind: 'all',
        filter: {},
        scoped: true,
      })!
      return {
        parsed: compiled.parsed,
        count: countCollections(
          ctx.db,
          compiled.filter,
          undefined,
          compiled.extra,
        ).count,
      }
    }
    expect(total('lang:zh')).toEqual({
      parsed: 'lang:zh',
      count:
        (counts['zh-Hans'] ?? 0) + (counts['zh-Hant'] ?? 0) + (counts.zh ?? 0),
    })
    expect(total('lang:ZH-hant')).toEqual({
      parsed: 'lang:zh-Hant',
      count: counts['zh-Hant'],
    })
    expect(total('lang:ja')).toEqual({ parsed: 'lang:ja', count: counts.ja })
  })

  test('aggregate by=lang: a bucket per stored value', () => {
    const result = aggregate(reader, {
      params: { by: ['lang'], q: ['type:post OR type:profile'] },
    })
    expect(
      Object.fromEntries(result.buckets.map((b) => [b.key, b.count])),
    ).toEqual(langs())
  })
})

describe('plans', () => {
  test.each([
    ['#cats', /SEARCH post_hashtags USING PRIMARY KEY \(value=\?\)/],
    ['mentions:@bob', /SEARCH post_mentions USING PRIMARY KEY \(value=\?\)/],
    ['domain:a.test', /SEARCH post_domains USING PRIMARY KEY \(value=\?\)/],
    [
      'has:link cat',
      /post_domains USING (COVERING INDEX|PRIMARY KEY).*catalog_id=\?|post_domains_catalog/,
    ],
    ['-from:@alice since:2026-01-01', /catalog_author \(author_entity_id=\?\)/],
    ['#cats OR #dogs OR mentions:@bob', /UNION|COMPOUND/],
    ['cat OR dog', /VIRTUAL TABLE INDEX/],
    ['tag:red OR (tag:blue cat)', /SEARCH ct USING .*collection_tags/],
    ['rel:mutual:@alice OR #cats', /follow_edges_follower/],
    ['state:deleted OR #cats', /collections_source_state/],
    ['quotes:@alice', /revision_entities_version \(entity_version_id=\?\)/],
    ['reposts:@carol', /entity_relations|revision_entities_version/],
    // From each revision of the account's rows, through its root and that
    // root's reposted relations, to the reposted posts' rows: each an index
    // seek. (Here the account's own rows are few enough to scan; on the
    // development copy they are read through catalog_subject.)
    [
      'reposted-by:@carol',
      /SEARCH rv USING (COVERING )?INDEX revisions_head \(collection_id=\?\)[\s\S]*SEARCH src USING INDEX revision_entities_root \(revision_id=\?\)[\s\S]*SEARCH edge USING COVERING INDEX sqlite_autoindex_entity_relations_1 \(revision_id=\? AND source_key=\? AND kind=\?\)[\s\S]*SEARCH kp USING (COVERING )?INDEX catalog_root \(root_entity_id=\?\)/,
    ],
    ['folder:imgs #cats', /SEARCH post_hashtags/],
  ])('%s', (text, pattern) => {
    expect(plan(text)).toMatch(pattern)
  })
})

// --- One engine ------------------------------------------------------------------

describe('what the filter can say', () => {
  test('runs as the filter: the same filter, no SQL of its own', () => {
    const tagged = (q: string, structured: Record<string, string[]>) => [
      readSearch(reader, 'posts', { q: [q] }),
      readSearch(reader, 'posts', structured),
    ]
    const alice = `fake/fake.profile/1`
    for (const [q, structured] of [
      ['cat', { q: ['cat'] }],
      ['猫 sun', { q: ['猫 sun'] }],
      ['from:@alice', { author: [alice] }],
      ['has:image', { media_type: ['image'] }],
      ['tag:red', { tag: ['red'] }],
      ['tag:red tag:blue', { tag: ['red', 'blue'], tag_mode: ['all'] }],
      ['tag:red OR tag:blue', { tag: ['red', 'blue'] }],
      ['cat -tag:red', { q: ['cat'], not_tag: ['red'] }],
      ['is:quote', { post_type: ['quote'] }],
      ['is:original', { post_type: ['post'] }],
      ['sensitive:yes', { sensitive: ['true'] }],
      ['state:deleted', { source_state: ['deleted'] }],
      ['platform:fake', { platform: ['fake'] }],
      ['saved:7d', { saved_within: ['7d'] }],
      ['rel:following:@alice', { rel_of: [alice], rel: ['following'] }],
      [
        'cat from:@alice has:image tag:red is:quote',
        {
          q: ['cat'],
          author: [alice],
          media_type: ['image'],
          tag: ['red'],
          post_type: ['quote'],
        },
      ],
    ] as const) {
      const [a, b] = tagged(
        q,
        structured as unknown as Record<string, string[]>,
      )
      expect(a!.extra, q).toBeUndefined()
      expect(a!.filter, q).toEqual(b!.filter)
    }
  })

  test('folder: in the query reads as folder= does', () => {
    const folder = ctx.db.get<{ id: string }>(sql`SELECT id FROM folders`)!.id
    const a = readSearch(reader, 'posts', { q: ['folder:imgs cat'] })
    const b = readSearch(reader, 'posts', { folder: [folder], q: ['cat'] })
    expect(a.extra).toBeUndefined()
    expect(b.extra).toBeUndefined()
    expect(a.filter).toEqual(b.filter)
  })

  test('only exclusions need a scope', () => {
    expect(() => readSearch(reader, 'posts', { q: ['-#cats'] })).toThrow(
      /only exclusions/,
    )
    expect(() =>
      readSearch(reader, 'posts', { q: ['-#cats since:2026-01-01'] }),
    ).not.toThrow()
    expect(() =>
      readSearch(reader, 'posts', { q: ['-#cats'], tag: ['red'] }),
    ).not.toThrow()
  })
})

// --- Folders -----------------------------------------------------------------

/** The collections a selection holds, as the list reads it. */
function members(filter: CollectionFilter, extra?: QueryExtra): string[] {
  const { ctes, source, where } = wholeSelection(
    ctx.db,
    filter,
    undefined,
    extra,
  )
  return ctx.db
    .all<{ id: string }>(
      sql`${ctes} SELECT k.collection_id AS id
      FROM ${sql.raw(source)} WHERE ${where}`,
    )
    .map((r) => r.id)
    .toSorted()
}

describe('folders as queries', () => {
  test('a list filter, converted, selects what it did, as that filter', () => {
    const tag = (name: string) =>
      ctx.db.get<{ id: string }>(sql`SELECT id FROM tags WHERE name = ${name}`)!
        .id
    const [red, blue] = [tag('red'), tag('blue')]
    const [alice, bob, carol] = ['1', '2', '3'].map(
      (id) => `fake/fake.profile/${id}`,
    ) as [string, string, string]
    const saved = ctx.db.all<{ at: number }>(
      sql`SELECT created_at AS at FROM library ORDER BY created_at`,
    )
    const middle = saved[Math.floor(saved.length / 2)]!.at
    // As the web wrote them: in UTC, and in a zone.
    const utc = new Date(middle).toISOString()
    const zoned = `${new Date(middle + 9 * 3_600_000).toISOString().slice(0, 19)}+09:00`
    const filters = [
      '',
      'q=cat',
      'q=the+cat',
      'q=%E7%8C%AB+sun',
      'q=%23cats',
      'q=OR',
      'q=from%3Aalice',
      'q=-dog',
      'q=%22sun%22',
      'entity_type=fake.post',
      'entity_type=fake.profile',
      'entity_type=fake.post%2Cfake.profile',
      'media_type=image',
      'media_type=image%2Cvideo',
      'media_type=text',
      'media_type=image%2Ctext',
      'media_type=image%2Ctext%2Cvideo',
      'visibility=public',
      'visibility=private',
      'sensitive=contains',
      'sensitive=not_contains',
      `author=${alice}`,
      `author=${alice}&author=${carol}`,
      `tag=${red}`,
      `tag=${red}%2C${blue}`,
      `tag=${red}%2C${blue}&tag_mode=all`,
      `not_tag=${red}`,
      `not_tag=${blue}%2C${red}`,
      `not_tag=${red}&tag=${blue}`,
      `related_to=${ids.p0}`,
      'post_type=post',
      'post_type=quote',
      'post_type=repost',
      'source_state=deleted',
      `rel=following&rel_of=${alice}`,
      `rel=followers&rel_of=${alice}&rel_of=${carol}`,
      `rel=followers&rel_min=1&rel_of=${alice}&rel_of=${carol}`,
      `rel=mutual&rel_of=${alice}&rel_of=${bob}&rel_of=${carol}`,
      `saved_from=${encodeURIComponent(utc)}`,
      `saved_before=${encodeURIComponent(zoned)}`,
      `saved_from=${encodeURIComponent(zoned)}&saved_before=${encodeURIComponent(utc)}`,
      'saved_within=30d',
      'saved_within=7d&tz=Asia%2FTokyo',
      'order=asc&sort=saved',
      `entity_type=fake.post&media_type=image&q=cat&sort=published&author=${alice}&author=${bob}&not_tag=${red}`,
      `entity_type=fake.profile&tag=${blue}&visibility=public`,
    ]
    /**
     * The filter as the folder gives it back: its moments in UTC, its
     * words as query text (the list reads `q` as a query).
     */
    const shown = (raw: string) => {
      const params = new URLSearchParams(raw)
      for (const key of ['saved_from', 'saved_before']) {
        const at = params.get(key)
        if (at) params.set(key, new Date(at).toISOString())
      }
      const q = params.get('q')
      if (q)
        params.set(
          'q',
          q
            .split(' ')
            .map((word) => wordTerm(word))
            .join(' '),
        )
      return parseFilterQuery(params.toString()).canonical
    }
    for (const raw of filters) {
      const { filter } = parseFilterQuery(raw)
      const converted = filterToQuery(raw)
      const folder = {
        ...converted,
        query: storedQuery(ctx.db, reader.types, converted.query, converted.tz),
      }
      const selection = folderSelection(ctx.db, reader.types, folder)
      const label = `${raw} → ${folder.query}`
      expect(members(selection.filter, selection.extra), label).toEqual(
        members(filter),
      )
      expect(
        countCollections(ctx.db, selection.filter, undefined, selection.extra),
        label,
      ).toEqual(countCollections(ctx.db, filter))
      // The same filter, so the same statements and plans; and the filter
      // controls show it.
      expect(selection.extra, label).toBeUndefined()
      const filterShown = folderFilter(ctx.db, reader.types, folder)
      expect(filterShown, label).toBe(shown(raw))
      // Which the list reads as the folder.
      const again = filterToQuery(filterShown!)
      expect(
        members(
          compileQuery(new URLSearchParams(filterShown!).get('q') ?? '', {
            db: ctx.db,
            types: reader.types,
            kind: 'all',
            filter: { ...parseFilterQuery(filterShown!).filter, q: undefined },
            scoped: true,
          })?.filter ?? parseFilterQuery(filterShown!).filter,
        ),
        label,
      ).toEqual(members(filter))
      expect(again.sort).toBe(converted.sort)
    }
  })

  test('include other folders, never themselves', () => {
    const imgs = ctx.db.get<{ id: string }>(
      sql`SELECT id FROM folders WHERE name = 'imgs'`,
    )!.id
    const cats = createFolder(
      ctx.db,
      { name: 'cats', query: 'folder:imgs cat' },
      reader.types,
    )
    const fewer = createFolder(
      ctx.db,
      { name: 'fewer', query: 'folder:cats -tag:red' },
      reader.types,
    )
    expect(fewer.query).toBe('folder:cats -tag:red')
    const whole = folderSelection(ctx.db, reader.types, fewer)
    const plain = compileQuery('has:image cat -tag:red', {
      db: ctx.db,
      types: reader.types,
      kind: 'all',
      filter: {},
      scoped: true,
    })!
    expect(members(whole.filter, whole.extra)).toEqual(
      members(plain.filter, plain.extra),
    )
    expect(members(whole.filter, whole.extra).length).toBeGreaterThan(0)
    // As the list reads it: one filter, no SQL of its own.
    expect(whole.extra).toBeUndefined()
    expect(filterString(whole.filter)).toBe(filterString(plain.filter))
    for (const query of ['folder:fewer', 'cat OR folder:cats'])
      expect(() => updateFolder(ctx.db, imgs, { query }, reader.types)).toThrow(
        /include each other/,
      )
    expect(() =>
      updateFolder(ctx.db, cats.id, { query: 'folder:cats' }, reader.types),
    ).toThrow(/cannot include itself/)
  })
})
