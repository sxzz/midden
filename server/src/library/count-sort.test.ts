import { readdirSync, readFileSync } from 'node:fs'
import { asc } from 'drizzle-orm'
import { afterEach, describe, expect, test } from 'vitest'
import { catalog } from '#db/schema.ts'
import { createApi } from '#http/app.ts'
import {
  capture,
  entity,
  expectCatalogFresh,
  graph,
  libraryContext,
} from '#testing/library.ts'
import { createFolder } from './folders.ts'
import { listCollections, type CollectionFilter } from './list.ts'
import { createShare } from './shares.ts'
import type { AccountsContext } from '#accounts/accounts.ts'
import type { CaptureContext } from '#capture/context.ts'
import type { FetchResponse } from '#platforms/protocol.ts'

let ctx: CaptureContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  if (ctx) expectCatalogFresh(ctx)
  ctx = undefined
})

/** What each account's profile says now; absent counts are unknown. */
type Counts = Record<string, { followers?: unknown; following?: unknown }>

function setup(counts: Counts) {
  const made = libraryContext((req) => {
    if (req.kind === 'post')
      return {
        text: `post ${req.externalId}`,
        graph: graph([entity('root', 'fake.post', req.externalId)]),
      } satisfies Partial<FetchResponse>
    // A profile address names the account by its handle.
    const metadata = counts[req.externalId.replace(/^handle:/, '')] ?? {}
    return {
      text: `account ${req.externalId}`,
      graph: graph([
        entity('root', 'fake.profile', req.externalId, { metadata }),
      ]),
    }
  })
  ctx = made.ctx
  return made.ctx
}

const profile = (id: string) => `https://fake.test/u/${id}`
const post = (id: string) => `https://fake.test/p/${id}`

/** Every page of a listing, as ids. */
function all(c: CaptureContext, filter: CollectionFilter) {
  const ids: string[] = []
  let cursor: string | undefined
  do {
    const page = listCollections(c, filter, cursor)
    ids.push(...page.items.map((item) => item.id))
    cursor = page.next_cursor
  } while (cursor)
  return ids
}

const ACCOUNTS = { entityType: 'fake.profile' }

/**
 * 25 accounts, more than a page: followers 0..9 each twice (ties), five
 * unknown (one never said, one said it as text); following runs the other
 * way.
 */
async function accounts() {
  const counts: Counts = {}
  for (let i = 0; i < 20; i++)
    counts[`a${i}`] = { followers: Math.floor(i / 2), following: 100 - i }
  counts.u0 = {}
  counts.u1 = { followers: '12' }
  counts.u2 = { followers: -1 }
  counts.u3 = { followers: 1.5 }
  counts.u4 = { following: 7 }
  const c = setup(counts)
  const ids: Record<string, string> = {}
  for (const name of Object.keys(counts))
    ids[name] = (await capture(c, profile(name))).collectionId
  const posts = [
    (await capture(c, post('p0'))).collectionId,
    (await capture(c, post('p1'))).collectionId,
  ]
  return { c, counts, ids, posts }
}

/** The expected order: known counts by count then id, unknown after by id. */
function expected(
  counts: Counts,
  ids: Record<string, string>,
  key: 'followers' | 'following',
  order: 'asc' | 'desc',
) {
  const sign = order === 'asc' ? 1 : -1
  const known = (v: unknown) =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0
  const rows = Object.entries(counts).map(([name, c]) => ({
    id: ids[name]!,
    n: known(c[key]) ? (c[key] as number) : undefined,
  }))
  const byId = (a: { id: string }, b: { id: string }) =>
    sign * (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  return [
    ...rows
      .filter((r) => r.n !== undefined)
      .toSorted((a, b) => sign * (a.n! - b.n!) || byId(a, b)),
    ...rows.filter((r) => r.n === undefined).toSorted(byId),
  ].map((r) => r.id)
}

describe('account count orders', () => {
  test('order by count either way, unknown last, page by cursor', async () => {
    const { c, counts, ids } = await accounts()
    for (const sort of ['followers', 'following'] as const)
      for (const order of ['desc', 'asc'] as const) {
        const filter = { ...ACCOUNTS, sort, order }
        const first = listCollections(c, filter)
        expect(first.items).toHaveLength(20)
        expect(first.next_cursor).toBeDefined()
        expect(all(c, filter)).toEqual(expected(counts, ids, sort, order))
      }
    // Without an order, the most first.
    expect(all(c, { ...ACCOUNTS, sort: 'followers' })).toEqual(
      expected(counts, ids, 'followers', 'desc'),
    )
    // A cursor belongs to its order.
    const page = listCollections(c, { ...ACCOUNTS, sort: 'followers' })
    for (const other of [
      { ...ACCOUNTS, sort: 'following' },
      { ...ACCOUNTS, sort: 'followers', order: 'asc' },
      { ...ACCOUNTS, sort: 'storage' },
    ])
      expect(() => listCollections(c, other, page.next_cursor)).toThrow(
        '翻页位置无效，请刷新后重试',
      )
  })

  test('only a list of accounts alone is ordered by counts', async () => {
    const { c, counts, ids, posts } = await accounts()
    // Posts have no counts: the order is ignored, leaving the newest update
    // first, as without one. So is a list that may hold both.
    for (const entityType of ['fake.post', 'fake.post,fake.profile', ''])
      for (const sort of ['followers', 'following'])
        for (const order of ['desc', 'asc']) {
          const filter = { entityType, order }
          expect(all(c, { ...filter, sort })).toEqual(
            all(c, { ...filter, sort: 'updated' }),
          )
        }
    expect(all(c, { entityType: 'fake.post', sort: 'followers' })).toEqual(
      posts.toReversed(),
    )
    expect(all(c, { sort: 'followers' })).toHaveLength(
      Object.keys(ids).length + posts.length,
    )
    // A narrowing to accounts makes it a list of accounts alone.
    const narrowed = listCollections(
      c,
      { sort: 'followers' },
      undefined,
      ACCOUNTS,
    )
    expect(narrowed.items.map((item) => item.id)).toEqual(
      expected(counts, ids, 'followers', 'desc').slice(0, 20),
    )
  })

  test('a new capture with other counts moves the account', async () => {
    const counts: Counts = {
      a: { followers: 5, following: 1 },
      b: { followers: 3, following: 2 },
    }
    const c = setup(counts)
    const a = (await capture(c, profile('a'))).collectionId
    const b = (await capture(c, profile('b'))).collectionId
    const followers = () => all(c, { ...ACCOUNTS, sort: 'followers' })
    expect(followers()).toEqual([a, b])
    // Counts alone change: no new version, but the catalog follows.
    counts.b = { followers: 9, following: 2 }
    await capture(c, profile('b'))
    expect(followers()).toEqual([b, a])
    // A capture without any counts leaves the last ones read, as the page
    // shows them.
    counts.b = {}
    await capture(c, profile('b'))
    expect(followers()).toEqual([b, a])
    // One that left this count out of the others makes it unknown.
    counts.b = { following: 2 }
    await capture(c, profile('b'))
    expect(followers()).toEqual([a, b])
    expect(all(c, { ...ACCOUNTS, sort: 'followers', order: 'asc' })).toEqual([
      a,
      b,
    ])
  })

  test('the migration fills the counts of rows already catalogued', async () => {
    const { c } = await accounts()
    const rows = () =>
      c.db
        .select({
          id: catalog.collectionId,
          followers: catalog.followersCount,
          following: catalog.followingCount,
        })
        .from(catalog)
        .orderBy(asc(catalog.collectionId))
        .all()
    const kept = rows()
    expect(kept.filter((row) => row.followers !== null)).toHaveLength(20)
    // Back to the table before the migrations, then through them.
    const client = c.db.$client
    for (const name of ['followers', 'following']) {
      for (const order of ['desc', 'asc']) {
        client.exec(`DROP INDEX catalog_${name}_${order}`)
        client.exec(`ALTER TABLE catalog DROP COLUMN ${name}_${order}`)
      }
      client.exec(`ALTER TABLE catalog DROP COLUMN ${name}_count`)
    }
    const folder = new URL('../../drizzle/', import.meta.url)
    const migrations = readdirSync(folder)
      .filter((name) => /_catalog_follow_counts(?:_backfill)?$/.test(name))
      .toSorted()
    expect(migrations).toHaveLength(2)
    for (const name of migrations)
      for (const statement of readFileSync(
        new URL(`${name}/migration.sql`, folder),
        'utf8',
      ).split('--> statement-breakpoint'))
        client.exec(statement)
    expect(rows()).toEqual(kept)
  })

  test('folders keep the order; public lists offer it', async () => {
    const { c, counts, ids } = await accounts()
    const folder = createFolder(c.db, {
      name: '账号',
      filter: 'entity_type=fake.profile&sort=following&order=asc',
    })
    expect(folder.filter).toBe(
      'entity_type=fake.profile&order=asc&sort=following',
    )
    const slug = createShare(c.db, { target: 'folder', id: folder.id }).slug
    const app = createApi({ ctx: c as AccountsContext })
    const read = async (query: string) => {
      const response = await app.request(`/public/${slug}/collections${query}`)
      return {
        status: response.status,
        body: (await response.json()) as {
          items: { id: string }[]
          next_cursor?: string
        },
      }
    }
    const first = await read('?sort=followers')
    expect(first.status).toBe(200)
    const second = await read(
      `?sort=followers&cursor=${first.body.next_cursor}`,
    )
    expect(
      [...first.body.items, ...second.body.items].map((item) => item.id),
    ).toEqual(expected(counts, ids, 'followers', 'desc'))
    const following = await read('?sort=following&order=asc')
    expect(following.body.items.map((item) => item.id)).toEqual(
      expected(counts, ids, 'following', 'asc').slice(0, 20),
    )
    // The default stays the update time.
    expect((await read('')).body.items.map((item) => item.id)).toEqual(
      (await read('?sort=updated')).body.items.map((item) => item.id),
    )
  })
})
