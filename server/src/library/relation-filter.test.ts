import { sql } from 'drizzle-orm'
import { afterEach, describe, expect, test } from 'vitest'
import { connections, relationFetches } from '#db/schema.ts'
import { isAppError } from '#errors.ts'
import { capture, entity, graph, libraryContext } from '#testing/library.ts'
import { updateAnnotation } from './annotations.ts'
import { filterCounts } from './counts.ts'
import { parseFilterQuery } from './filter-query.ts'
import { createFolder } from './folders.ts'
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
  return { c, ids, list, entityOf }
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
      list({ relOf: key('pat'), rel, entityType })
    expect(of('following', PROFILES)).toEqual(['alice', 'bob'])
    expect(of('followers', PROFILES)).toEqual(['alice', 'carol'])
    expect(of('mutual', PROFILES)).toEqual(['alice'])
    expect(of('following', POSTS)).toEqual(['a1', 'b1'])
    expect(of('followers', POSTS)).toEqual(['a1', 'c1'])
    expect(of('mutual', POSTS)).toEqual(['a1'])
    // Dan's follows ended both ways; the reverse perspective works too.
    expect(list({ relOf: key('dan'), rel: 'mutual' })).toEqual([])
    expect(list({ relOf: key('alice'), rel: 'mutual' })).toEqual(['p1', 'pat'])
    // An account with no follows, or none stored at all, selects nothing.
    expect(list({ relOf: key('eve'), rel: 'followers' })).toEqual([])
    expect(list({ relOf: key('nobody'), rel: 'following' })).toEqual([])
  })

  test('combines with the other filters', async () => {
    const { c, ids, list } = await setup()
    const pat = { relOf: key('pat'), rel: 'following' }
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
    const page = listCollections(c, { relOf: key('pat'), rel: 'following' })
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
    expect(folder).toMatchObject({
      filter: `entity_type=fake.profile&rel=mutual&rel_of=${pat}`,
      count: 1,
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
    expect(listPerspectives(c, { relOf: key('eve') }).items).toEqual([
      {
        id: key('eve'),
        name: 'EVE',
        username: 'eve',
        following: {},
        followers: {},
      },
    ])
    expect(listPerspectives(c, { relOf: key('nobody') }).items).toEqual([])
    expect(listPerspectives(c, { cursor: '3' }).items).toHaveLength(2)
    invalid(() => listPerspectives(c, { cursor: '03' }))
    invalid(() => listPerspectives(c, { relOf: 'pat' }))
  })
})
