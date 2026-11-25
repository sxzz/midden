import { sql } from 'drizzle-orm'
import { afterEach, describe, expect, test } from 'vitest'
import { connections, relationFetches } from '#db/schema.ts'
import { isAppError } from '#errors.ts'
import { capture, entity, graph, libraryContext } from '#testing/library.ts'
import { updateAnnotation } from './annotations.ts'
import { compareRelations } from './compare.ts'
import { filterCounts } from './counts.ts'
import { parseFilterQuery } from './filter-query.ts'
import { createFolder } from './folders.ts'
import { accountGraph, followGraph } from './follow-graph.ts'
import { listCollections, type CollectionFilter } from './list.ts'
import { listPerspectives } from './perspectives.ts'
import type { CaptureContext } from '#capture/context.ts'

let ctx: CaptureContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

const AUTHORS: Record<string, string> = {
  a: 'alice',
  b: 'bob',
  c: 'carol',
  d: 'dan',
  p: 'pat',
}

/** The fake platform keeps numeric profile ids as they are. */
const NUMBERS: Record<string, string> = {
  alice: '11',
  bob: '12',
  carol: '13',
  dan: '14',
  pat: '15',
  eve: '16',
}
const handleOf = (id: string) =>
  Object.keys(NUMBERS).find((handle) => NUMBERS[handle] === id) ?? id
const numberOf = (handle: string) => NUMBERS[handle] ?? handle

const key = (handle: string) => `fake/fake.profile/${numberOf(handle)}`

/**
 * Pat follows Alice and Bob, Alice and Carol follow Pat; Pat and Dan
 * followed each other once. Each has a saved profile and one post; Eve has
 * a profile and no follows at all.
 */
async function setup() {
  const made = libraryContext((req) => {
    const handle = handleOf(req.externalId)
    return req.kind === 'profile'
      ? {
          text: handle,
          graph: graph([
            entity('root', 'fake.profile', req.externalId, {
              name: handle.toUpperCase(),
              username: handle,
            }),
          ]),
        }
      : {
          text: `post ${req.externalId}`,
          graph: graph(
            [
              entity('root', 'fake.post', req.externalId),
              entity(
                'author',
                'fake.profile',
                numberOf(AUTHORS[req.externalId[0]!]!),
              ),
            ],
            ['root', 'authored_by', 'author'],
          ),
        }
  })
  const c = made.ctx
  ctx = c
  const ids: Record<string, string> = {}
  for (const handle of [...Object.values(AUTHORS), 'eve'])
    ids[handle] = (
      await capture(c, `https://fake.test/u/${numberOf(handle)}`)
    ).collectionId
  for (const id of ['a1', 'b1', 'c1', 'd1', 'p1'])
    ids[id] = (await capture(c, `https://fake.test/p/${id}`)).collectionId
  const entityOf = (handle: string) =>
    c.db.get<{ id: string }>(
      sql`SELECT id FROM entities WHERE kind = 'fake.profile'
        AND external_id = ${numberOf(handle)}`,
    )!.id
  const follow = (from: string, to: string, ended?: number) =>
    c.db.run(sql`INSERT INTO follow_edges
      (follower_id, followee_id, first_seen_at, last_seen_at, ended_at)
      VALUES (${entityOf(from)}, ${entityOf(to)}, 1000, 2000, ${ended ?? null})`)
  follow('pat', 'alice')
  follow('alice', 'pat')
  follow('pat', 'bob')
  follow('carol', 'pat')
  follow('pat', 'dan', 3000)
  follow('dan', 'pat', 3000)
  const named = (items: { id: string }[]) =>
    items
      .map((item) => Object.entries(ids).find(([, id]) => id === item.id)![0])
      .toSorted()
  const list = (filter: CollectionFilter) =>
    named(listCollections(c, filter).items)
  return { c, ids, list, entityOf, follow }
}

const PROFILES = 'fake.profile'
const POSTS = 'fake.post'

function invalid(run: () => unknown) {
  try {
    run()
  } catch (error) {
    expect(isAppError(error)).toBe(true)
    expect(error).toMatchObject({ kind: 'invalid_filter' })
    return
  }
  throw new Error('expected invalid_filter')
}

describe('the 关系 filter', () => {
  test('selects current follows, both tabs, each way', async () => {
    const { list } = await setup()
    const of = (rel: string, entityType: string) =>
      list({ relOf: [key('pat')], rel, entityType })
    expect(of('following', PROFILES)).toEqual(['alice', 'bob'])
    expect(of('followers', PROFILES)).toEqual(['alice', 'carol'])
    expect(of('mutual', PROFILES)).toEqual(['alice'])
    expect(of('following', POSTS)).toEqual(['a1', 'b1'])
    expect(of('followers', POSTS)).toEqual(['a1', 'c1'])
    expect(of('mutual', POSTS)).toEqual(['a1'])
    // Dan's follows ended both ways; the reverse perspective works too.
    expect(list({ relOf: [key('dan')], rel: 'mutual' })).toEqual([])
    expect(list({ relOf: [key('alice')], rel: 'mutual' })).toEqual([
      'p1',
      'pat',
    ])
    // An account with no follows, or none stored at all, selects nothing.
    expect(list({ relOf: [key('eve')], rel: 'followers' })).toEqual([])
    expect(list({ relOf: [key('nobody')], rel: 'following' })).toEqual([])
  })

  test('combines with the other filters', async () => {
    const { c, ids, list } = await setup()
    const pat = { relOf: [key('pat')], rel: 'following' }
    expect(list({ ...pat, authors: [key('bob')] })).toEqual(['b1'])
    expect(list({ ...pat, q: 'a1' })).toEqual(['a1'])
    expect(list({ ...pat, entityType: `${POSTS},${PROFILES}` })).toEqual([
      'a1',
      'alice',
      'b1',
      'bob',
    ])
    const tag = updateAnnotation(c.db, ids.bob!, { tagNames: ['友'] }).tags[0]!
    // Bob's tag covers his posts too.
    expect(list({ ...pat, tag: tag.id })).toEqual(['b1', 'bob'])
    expect(list({ ...pat, notTag: tag.id })).toEqual(['a1', 'alice'])
    // Within a profile's related list as well.
    expect(list({ ...pat, relatedTo: ids.alice, entityType: POSTS })).toEqual([
      'a1',
    ])
  })

  test('counts and pages per perspective and mode', async () => {
    const { c } = await setup()
    const count = (query: string) => filterCounts(c.db, query).count
    const pat = `rel_of=${encodeURIComponent(key('pat'))}`
    expect(count(`${pat}&rel=following`)).toBe(4)
    expect(count(`${pat}&rel=mutual`)).toBe(2)
    expect(
      count(`rel_of=${encodeURIComponent(key('carol'))}&rel=following`),
    ).toBe(2)
    // A cursor belongs to its filter.
    const page = listCollections(c, { relOf: [key('pat')], rel: 'following' })
    expect(page.next_cursor).toBeUndefined()
  })

  test('validates and normalizes for folders', async () => {
    const { c } = await setup()
    const pat = encodeURIComponent(key('pat'))
    expect(parseFilterQuery(`rel=mutual&q=&rel_of=${pat}`).canonical).toBe(
      `rel=mutual&rel_of=${pat}`,
    )
    const folder = createFolder(c.db, {
      name: '互关',
      filter: `rel=mutual&rel_of=${pat}&entity_type=fake.profile`,
    })
    // Alice and her post: a folder keeps the platform, not the kind.
    expect(folder).toMatchObject({
      filter: `entity_type=fake.post%2Cfake.profile&rel=mutual&rel_of=${pat}`,
      count: 2,
    })
    for (const query of [
      'rel=following',
      `rel_of=${pat}`,
      `rel_of=${pat}&rel=friends`,
      `rel_of=${encodeURIComponent('fake/fake.post/p1')}&rel=following`,
      'rel_of=fake%2F15&rel=following',
      // Only the canonical key names the account.
      'rel_of=fake%2Ffake.profile%2F%2531%2535&rel=following',
    ])
      invalid(() => {
        const { filter } = parseFilterQuery(query)
        listCollections(c, filter)
      })
    invalid(() => createFolder(c.db, { name: 'x', filter: 'rel=following' }))
  })
})

describe('perspectives', () => {
  test('only accounts with relation data, own capture accounts first', async () => {
    const { c, entityOf } = await setup()
    const handles = () => listPerspectives(c).items.map((item) => item.username)
    // By how many current follows involve them: Pat 4, Alice 2, Dan none
    // now but some before; Eve none ever.
    expect(handles()).toEqual(['pat', 'alice', 'bob', 'carol', 'dan'])
    c.db
      .insert(relationFetches)
      .values({
        id: '00000000-0000-7000-8000-000000000001',
        list: 'followers',
        entityId: entityOf('bob'),
        state: 'complete',
        finishedAt: new Date('2026-11-20T00:00:00Z'),
      })
      .run()
    c.db
      .insert(relationFetches)
      .values({
        id: '00000000-0000-7000-8000-000000000002',
        list: 'following',
        entityId: entityOf('eve'),
        state: 'partial',
        finishedAt: new Date('2026-11-21T00:00:00Z'),
      })
      .run()
    // Eve now has a fetch of hers; fetched accounts come before the rest.
    expect(handles()).toEqual(['eve', 'bob', 'pat', 'alice', 'carol', 'dan'])
    for (const [i, [accountId, state]] of (
      [
        ['dan', 'ready'],
        ['carol', 'revoked'],
        ['zed', 'ready'],
      ] as const
    ).entries())
      c.db
        .insert(connections)
        .values({
          id: `00000000-0000-7000-8000-00000000010${i}`,
          adapterId: 'fake',
          providerId: 'session',
          name: accountId,
          accountId: numberOf(accountId),
          state,
        })
        .run()
    // Dan is the owner's; a revoked one or one without data is not pinned.
    const items = listPerspectives(c).items
    expect(items.map((item) => item.username)).toEqual([
      'dan',
      'eve',
      'bob',
      'pat',
      'alice',
      'carol',
    ])
    expect(items[0]).toEqual({
      id: key('dan'),
      name: 'DAN',
      username: 'dan',
      own: true,
      following: {},
      followers: {},
    })
    expect(items[1]).toMatchObject({
      following: { partial_at: '2026-11-21T00:00:00.000Z' },
      followers: {},
    })
    expect(items[2]).toMatchObject({
      following: {},
      followers: { complete_at: '2026-11-20T00:00:00.000Z' },
    })
  })

  test('search, pages and a chosen one', async () => {
    const { c } = await setup()
    expect(
      listPerspectives(c, { q: 'AR' }).items.map((item) => item.username),
    ).toEqual(['carol'])
    expect(listPerspectives(c, { q: '%' }).items).toEqual([])
    expect(listPerspectives(c, { relOf: [key('eve')] }).items).toEqual([
      {
        id: key('eve'),
        name: 'EVE',
        username: 'eve',
        following: {},
        followers: {},
        no_data: true,
      },
    ])
    // Several at once, each saying whether it has data.
    expect(
      listPerspectives(c, { relOf: [key('eve'), key('pat'), key('nobody')] })
        .items.map((item) => [item.username, item.no_data ?? false])
        .toSorted(),
    ).toEqual([
      ['eve', true],
      ['pat', false],
    ])
    expect(listPerspectives(c, { relOf: [key('nobody')] }).items).toEqual([])
    expect(listPerspectives(c, { cursor: '3' }).items).toHaveLength(2)
    invalid(() => listPerspectives(c, { cursor: '03' }))
    invalid(() => listPerspectives(c, { relOf: ['pat'] }))
  })
})

/**
 * On top of the base follows: Alice and Carol follow Bob, Carol follows
 * Alice and Eve; Bob and Dan followed Alice once.
 */
async function several() {
  const made = await setup()
  const { follow } = made
  follow('alice', 'bob')
  follow('carol', 'bob')
  follow('carol', 'alice')
  follow('carol', 'eve')
  follow('bob', 'alice', 3000)
  follow('dan', 'alice', 3000)
  return made
}

describe('the 关系 filter with several perspectives', () => {
  test('selects accounts related to at least k of them', async () => {
    const { list } = await several()
    const of = (handles: string[], rel: string, relMin?: string) =>
      list({
        relOf: handles.map((handle) => key(handle)),
        rel,
        relMin,
        entityType: PROFILES,
      })
    // Pat follows Alice and Bob, Alice follows Pat and Bob: two by default.
    expect(of(['pat', 'alice'], 'following')).toEqual(['bob'])
    expect(of(['pat', 'alice'], 'following', '2')).toEqual(['bob'])
    // Any one of them.
    expect(of(['pat', 'alice'], 'following', '1')).toEqual([
      'alice',
      'bob',
      'pat',
    ])
    // Carol follows Pat, Bob, Alice and Eve.
    const three = ['pat', 'alice', 'carol']
    expect(of(three, 'following')).toEqual(['alice', 'bob', 'pat'])
    expect(of(three, 'following', '3')).toEqual(['bob'])
    // Followers: Carol follows both; Bob's and Dan's follows of Alice ended.
    expect(of(['pat', 'alice'], 'followers')).toEqual(['carol'])
    expect(of(['pat', 'alice'], 'followers', '1')).toEqual([
      'alice',
      'carol',
      'pat',
    ])
    // Mutual is each perspective's own: Pat and Alice are each other's.
    expect(of(['pat', 'alice'], 'mutual', '1')).toEqual(['alice', 'pat'])
    expect(of(['pat', 'alice'], 'mutual')).toEqual([])
    // An unknown perspective counts as one with no follows.
    expect(of(['pat', 'nobody'], 'following')).toEqual([])
    expect(of(['pat', 'nobody'], 'following', '1')).toEqual(['alice', 'bob'])
    // Posts by them, too.
    expect(
      list({ relOf: three.map((h) => key(h)), rel: 'following', relMin: '3' }),
    ).toEqual(['b1', 'bob'])
  })

  test('normalizes, counts apart and rejects what makes no sense', async () => {
    const { c } = await several()
    const pat = encodeURIComponent(key('pat'))
    const alice = encodeURIComponent(key('alice'))
    // A set, in order; the default threshold goes unsaid.
    expect(
      parseFilterQuery(
        `rel_of=${pat}&rel=following&rel_of=${alice}&rel_of=${pat}&rel_min=2`,
      ).canonical,
    ).toBe(`rel=following&rel_of=${alice}&rel_of=${pat}`)
    expect(
      parseFilterQuery(`rel_of=${pat}&rel_of=${alice}&rel=following&rel_min=1`)
        .canonical,
    ).toBe(`rel=following&rel_min=1&rel_of=${alice}&rel_of=${pat}`)
    expect(
      parseFilterQuery(`rel_of=${pat}&rel=following&rel_min=1`).canonical,
    ).toBe(`rel=following&rel_of=${pat}`)
    const folder = createFolder(c.db, {
      name: '共同关注',
      filter: `rel_of=${pat}&rel_of=${alice}&rel=following`,
    })
    expect(folder).toMatchObject({
      filter: `rel=following&rel_of=${alice}&rel_of=${pat}`,
      count: 2,
    })
    // Counted apart by threshold, cached by the canonical form.
    const count = (query: string) => filterCounts(c.db, query).count
    const both = `rel_of=${pat}&rel_of=${alice}&rel=following&entity_type=fake.profile`
    expect(count(both)).toBe(1)
    expect(count(`${both}&rel_min=1`)).toBe(3)
    expect(count(`${both}&rel_min=2`)).toBe(1)
    // One filter, one fingerprint, whatever the order.
    const a = listCollections(c, {
      relOf: [key('alice'), key('pat')],
      rel: 'following',
      relMin: '2',
    })
    const b = listCollections(c, {
      relOf: [key('pat'), key('alice'), key('pat')],
      rel: 'following',
    })
    expect(a).toEqual(b)
    for (const query of [
      `rel_of=${pat}&rel_of=${alice}&rel=following&rel_min=0`,
      `rel_of=${pat}&rel_of=${alice}&rel=following&rel_min=3`,
      `rel_of=${pat}&rel_of=${alice}&rel=following&rel_min=02`,
      `rel_of=${pat}&rel_of=${alice}&rel=following&rel_min=x`,
      `rel_of=${pat}&rel=following&rel_min=2`,
      'rel=following&rel_min=1',
      'rel_min=2',
      `rel_of=${pat}&rel_of=${alice}`,
      `rel_of=${pat}&rel_of=x&rel=following`,
    ])
      invalid(() => {
        const { filter } = parseFilterQuery(query)
        listCollections(c, filter)
      })
  })
})

describe('comparing accounts', () => {
  test('shared accounts, their subsets and the follows among the compared', async () => {
    const { c } = await several()
    // Pat follows Alice and Bob; Carol follows Pat, Bob, Alice and Eve.
    const keys = [key('pat'), key('carol')]
    const compared = compareRelations(c, { relOf: keys })
    expect(
      compared.accounts.map((a) => [a.key, a.username, a.collection_id]),
    ).toEqual([
      [key('pat'), 'pat', expect.any(String)],
      [key('carol'), 'carol', expect.any(String)],
    ])
    expect(compared.accounts[0]!.lists).toEqual({
      following: {},
      followers: {},
    })
    // Two in common by default; the compared themselves are left out.
    const named = (items: { username?: string; of: number[] }[]) =>
      items.map((item) => [item.username, item.of])
    expect(named(compared.items)).toEqual([
      ['alice', [0, 1]],
      ['bob', [0, 1]],
    ])
    expect(compared.total).toBe(2)
    expect(compared.combos).toEqual([{ of: [0, 1], count: 2 }])
    // Carol follows Pat; Alice and Pat follow each other; Alice follows Bob.
    const at = (i: number) =>
      i < 2 ? compared.accounts[i]!.username : compared.items[i - 2]!.username
    expect(
      compared.edges.map(([a, b]) => `${at(a)}>${at(b)}`).toSorted(),
    ).toEqual(
      [
        'pat>alice',
        'pat>bob',
        'carol>pat',
        'carol>alice',
        'carol>bob',
        'alice>pat',
        'alice>bob',
      ].toSorted(),
    )

    const any = compareRelations(c, { relOf: keys, min: 1 })
    expect(named(any.items)).toEqual([
      ['alice', [0, 1]],
      ['bob', [0, 1]],
      ['eve', [1]],
    ])
    expect(any.combos).toEqual([
      { of: [0, 1], count: 2 },
      { of: [1], count: 1 },
    ])
    // Exactly one subset.
    const onlyCarol = compareRelations(c, { relOf: keys, min: 1, only: [1] })
    expect(named(onlyCarol.items)).toEqual([['eve', [1]]])
    expect(onlyCarol.total).toBe(1)
    expect(onlyCarol.combos).toEqual(any.combos)
    // A cap, with the total.
    const capped = compareRelations(c, { relOf: keys, min: 1, limit: 1 })
    expect(capped.items).toHaveLength(1)
    expect(capped.total).toBe(3)
    // Followers: Alice follows Pat (Carol does too, but is compared).
    expect(
      named(
        compareRelations(c, { relOf: keys, rel: 'followers', min: 1 }).items,
      ),
    ).toEqual([['alice', [0]]])
    // Ended follows do not count: Bob and Dan once followed Alice.
    expect(
      compareRelations(c, {
        relOf: [key('alice'), key('pat')],
        rel: 'followers',
        min: 1,
      }).items.map((item) => item.username),
    ).toEqual(['carol'])
    // An account never stored is compared as one with nothing.
    const unknown = compareRelations(c, {
      relOf: [key('pat'), key('nobody')],
      min: 1,
    })
    expect(unknown.accounts[1]).toEqual({
      key: key('nobody'),
      external_id: 'nobody',
      lists: { following: {}, followers: {} },
    })
    expect(named(unknown.items)).toEqual([
      ['alice', [0]],
      ['bob', [0]],
    ])
  })

  test('rejects what it cannot compare', async () => {
    const { c } = await several()
    const keys = [key('pat'), key('carol')]
    for (const query of [
      { relOf: [] },
      { relOf: [key('pat'), key('pat')] },
      { relOf: ['fake/fake.post/p1'] },
      { relOf: keys, min: 3 },
      { relOf: keys, min: 0 },
      { relOf: keys, only: [2] },
      { relOf: keys, only: [1, 1] },
      { relOf: keys, rel: 'mutual' as 'following' },
    ])
      invalid(() => compareRelations(c, query))
  })

  test('stays quick with many perspectives and thousands of follows each', async () => {
    const { c } = await several()
    // 20 perspectives following 2000 accounts each, drawn from 8000.
    const now = Date.now()
    const accounts = Array.from({ length: 8000 }, (_, i) => `syn-a${i}`)
    const perspectives = Array.from({ length: 20 }, (_, i) => `syn-p${i}`)
    c.db.$client.exec(`INSERT INTO entities
      (id, platform, kind, external_id, observed_at) VALUES ${[
        ...accounts,
        ...perspectives,
      ]
        .map((id) => `('${id}', 'fake', 'fake.profile', '${id}', ${now})`)
        .join(',')}`)
    const edges: string[] = []
    perspectives.forEach((p, i) => {
      for (let j = 0; j < 2000; j++)
        edges.push(
          `('${p}', '${accounts[(i * 397 + j * 7) % accounts.length]}', ${now}, ${now})`,
        )
    })
    c.db.$client.exec(`INSERT OR IGNORE INTO follow_edges
      (follower_id, followee_id, first_seen_at, last_seen_at)
      VALUES ${edges.join(',')}`)
    const relOf = perspectives.map((id) => `fake/fake.profile/${id}`)
    let started = performance.now()
    filterCounts(
      c.db,
      new URLSearchParams([
        ...relOf.map((k) => ['rel_of', k]),
        ['rel', 'following'],
        ['rel_min', '3'],
      ]).toString(),
    )
    expect(performance.now() - started).toBeLessThan(1000)
    started = performance.now()
    const compared = compareRelations(c, { relOf, min: 2 })
    expect(performance.now() - started).toBeLessThan(2000)
    expect(compared.items).toHaveLength(300)
    expect(compared.combos.reduce((sum, combo) => sum + combo.count, 0)).toBe(
      compared.total,
    )
  })
})

describe('a viewer', () => {
  test('marks each node with how the viewer relates to it now', async () => {
    const { c, ids } = await several()
    // Alice follows Pat and Bob, Pat follows her back, Carol follows her.
    const seen = followGraph(c, ids.pat!, { viewer: key('alice') })
    expect(
      Object.fromEntries(
        seen.nodes.map((node) => [node.username, node.viewer ?? '']),
      ),
    ).toEqual({ pat: 'mutual', alice: '', bob: 'following', carol: 'follower' })
    expect(seen.viewer).toEqual({
      key: key('alice'),
      name: 'ALICE',
      username: 'alice',
      lists: { following: {}, followers: {} },
    })
    // Without one, nothing is marked.
    const plain = followGraph(c, ids.pat!)
    expect(plain.nodes.some((node) => node.viewer)).toBe(false)
    expect(plain).not.toHaveProperty('viewer')
    // Ended follows do not count: Bob and Dan once followed Alice.
    const compared = compareRelations(c, {
      relOf: [key('pat'), key('carol')],
      min: 1,
      viewer: key('alice'),
    })
    expect(
      [...compared.accounts, ...compared.items].map((node) => [
        node.username,
        node.viewer ?? '',
      ]),
    ).toEqual([
      ['pat', 'mutual'],
      ['carol', 'follower'],
      ['alice', ''],
      ['bob', 'following'],
      ['eve', ''],
    ])
    invalid(() => followGraph(c, ids.pat!, { viewer: 'fake/fake.post/p1' }))
  })
})

describe('an account graph', () => {
  test('centres on an account by its key, as its saved profile would', async () => {
    const { c, ids } = await several()
    const byKey = accountGraph(c, key('pat'), { viewer: key('alice') })
    expect(byKey).toEqual(followGraph(c, ids.pat!, { viewer: key('alice') }))
    expect(byKey.nodes[0]).toMatchObject({ key: key('pat') })
    // An account never stored has no graph; a post is no account.
    expect(accountGraph(c, 'fake/fake.profile/999')).toMatchObject({
      nodes: [],
      total: 0,
    })
    invalid(() => accountGraph(c, 'fake/fake.post/p1'))
    invalid(() => accountGraph(c, 'nonsense'))
  })
})
