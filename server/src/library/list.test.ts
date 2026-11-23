import { afterEach, describe, expect, test } from 'vitest'
import { collections } from '#db/schema.ts'
import {
  capture,
  entity,
  expectCatalogFresh,
  graph,
  image,
  libraryContext,
} from '#testing/library.ts'
import { updateAnnotation } from './annotations.ts'
import { catalogCollections } from './catalog.ts'
import { listAuthors, listCollections, type CollectionFilter } from './list.ts'
import { getCollection } from './read.ts'
import type { CaptureContext } from '#capture/context.ts'
import type { FetchResponse } from '#platforms/protocol.ts'
import type { CollectionView } from './views.ts'

let ctx: CaptureContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  if (ctx) expectCatalogFresh(ctx)
  ctx = undefined
})

type Route = () => Partial<FetchResponse>

function setup(routes: Record<string, Route>) {
  const made = libraryContext((req) => {
    const route = routes[req.externalId]
    if (!route) throw new Error(`no route for ${req.externalId}`)
    return route()
  })
  ctx = made.ctx
  return made
}

const post = (id: string) => `https://fake.test/p/${id}`
const profile = (id: string) => `https://fake.test/u/${id}`
const ids = (items: CollectionView[]) => items.map((c) => c.id)

/** Every page of a listing. */
function all(c: CaptureContext, filter: CollectionFilter = {}) {
  const items: CollectionView[] = []
  let cursor: string | undefined
  do {
    const page = listCollections(c, filter, cursor)
    items.push(...page.items)
    cursor = page.next_cursor
  } while (cursor)
  return items
}

const byAuthor =
  (id: string, author?: string, name?: string): Route =>
  () => ({
    text: `post ${id}`,
    ...(name ? { authorName: name } : {}),
    graph: author
      ? graph(
          [
            entity('root', 'fake.post', id),
            entity('author', 'fake.profile', author),
          ],
          ['root', 'authored_by', 'author'],
        )
      : graph([entity('root', 'fake.post', id)]),
  })

describe('library listing', () => {
  test('pages, search and sorting', async () => {
    const routes: Record<string, Route> = {}
    for (let i = 0; i < 22; i++)
      routes[`n${i}`] = () => ({
        // Pairs share a size, to check ties in storage order.
        text: `中文收藏 100% ${'x'.repeat(Math.floor(i / 2) * 50)}`,
        publishedAt:
          i === 0
            ? 'not a date'
            : `2026-01-${String(30 - i).padStart(2, '0')}T00:00:00Z`,
      })
    const { ctx } = setup(routes)
    const made: string[] = []
    for (let i = 0; i < 22; i++)
      made.push((await capture(ctx, post(`n${i}`))).collectionId)

    const first = listCollections(ctx)
    expect(first.items).toHaveLength(20)
    expect(first.total_storage_bytes).toBeUndefined()
    const second = listCollections(ctx, {}, first.next_cursor)
    expect(second.items).toHaveLength(2)
    expect(second.next_cursor).toBeUndefined()
    // Newest capture first.
    expect(ids([...first.items, ...second.items])).toEqual(made.toReversed())
    expect(() => listCollections(ctx, { q: 'x' }, first.next_cursor)).toThrow(
      'invalid cursor',
    )
    expect(() => listCollections(ctx, {}, 'garbage')).toThrow('invalid cursor')

    // Search is literal and covers the text.
    expect(all(ctx, { q: '中文' })).toHaveLength(22)
    expect(all(ctx, { q: '100%' })).toHaveLength(22)
    expect(all(ctx, { q: '1_0' })).toHaveLength(0)
    expect(
      listCollections(ctx, { q: '中文', mediaType: 'text' }).next_cursor,
    ).toBeDefined()

    // Publication time; an invalid one falls back to the capture time.
    const published = all(ctx, { sort: 'published' })
    expect(ids(published).slice(0, 3)).toEqual(made.slice(0, 3))
    const ascending = all(ctx, { sort: 'published', order: 'asc' })
    expect(ascending[0]?.id).toBe(made[21])
    expect(ascending.at(-1)?.id).toBe(made[0])
    const page = listCollections(ctx, { sort: 'published' })
    expect(() =>
      listCollections(ctx, { sort: 'captured' }, page.next_cursor),
    ).toThrow('invalid cursor')
    expect(() =>
      listCollections(
        ctx,
        { sort: 'published', order: 'asc' },
        page.next_cursor,
      ),
    ).toThrow('invalid cursor')

    // Storage order is stable across pages, ties by id.
    for (const order of ['asc', 'desc']) {
      const items = all(ctx, { sort: 'storage', order })
      expect(new Set(ids(items)).size).toBe(22)
      for (let i = 1; i < items.length; i++) {
        const [a, b] = [items[i - 1]!, items[i]!]
        const less =
          a.storage_bytes! < b.storage_bytes! ||
          (a.storage_bytes === b.storage_bytes && a.id < b.id)
        expect(less).toBe(order === 'asc')
      }
      expect(getCollection(ctx, items[3]!.id).storage_bytes).toBe(
        items[3]!.storage_bytes,
      )
    }

    // Equal times page deterministically by id.
    ctx.db
      .update(collections)
      .set({ observedAt: new Date(1e12) })
      .run()
    catalogCollections(ctx.db, made)
    expect(ids(all(ctx))).toEqual(made.toSorted().toReversed())

    for (const filter of [
      { sort: 'invalid' },
      { order: 'up' },
      { mediaType: 'image,invalid' },
      { sensitive: 'maybe' },
      { entityType: 'invalid type' },
      { relatedTo: 'not-a-uuid' },
      { tag: 'x' },
      { postType: 'thread' },
      { visibility: 'secret' },
      { q: 'x'.repeat(501) },
      { savedFrom: 'yesterday' },
      {
        savedFrom: '2026-01-02T00:00:00Z',
        savedBefore: '2026-01-01T00:00:00Z',
      },
    ])
      expect(() => listCollections(ctx, filter)).toThrow(
        'invalid collection filters',
      )
  })

  test('root type, media, sensitivity and save time', async () => {
    const { ctx } = setup({
      text: () => ({ text: 'just text' }),
      img: () => ({
        text: 'image',
        resources: [image('a.jpg')],
        graph: graph([entity('root', 'fake.post', 'img', {}, [0])]),
      }),
      nsfw: () => ({
        text: 'sensitive',
        resources: [image('b.jpg', { sensitive: true })],
        graph: graph([entity('root', 'fake.post', 'nsfw', {}, [0])]),
      }),
      lost: () => ({
        text: 'image that failed to download',
        resources: [image('missing/d.jpg')],
        graph: graph([entity('root', 'fake.post', 'lost', {}, [0])]),
      }),
      avatar: () => ({
        text: 'sensitive avatar only',
        resources: [image('c.jpg', { sensitive: true, purpose: 'avatar' })],
        graph: graph(
          [
            entity('root', 'fake.post', 'avatar'),
            entity('author', 'fake.profile', '9', {}, [0]),
          ],
          ['root', 'authored_by', 'author'],
        ),
      }),
      5: () => ({
        text: 'profile',
        graph: graph([entity('root', 'fake.profile', '5')]),
      }),
    })
    const saved: Record<string, string> = {}
    for (const id of ['text', 'img', 'nsfw', 'lost', 'avatar'])
      saved[id] = (await capture(ctx, post(id))).collectionId
    saved.profile = (await capture(ctx, profile('5'))).collectionId
    const match = (filter: CollectionFilter) =>
      new Set(
        all(ctx, filter).map(
          (c) => Object.entries(saved).find(([, id]) => id === c.id)![0],
        ),
      )
    expect(match({ entityType: 'fake.profile' })).toEqual(new Set(['profile']))
    // The text entry has no graph, so no root type at all.
    expect(match({ entityType: 'fake.post' })).toEqual(
      new Set(['img', 'nsfw', 'lost', 'avatar']),
    )
    expect(match({ entityType: 'fake.post,fake.profile' }).size).toBe(5)
    expect(match({ mediaType: 'text' })).toEqual(
      new Set(['text', 'avatar', 'profile']),
    )
    // Media count by what the post had, whether or not it was saved.
    expect(match({ mediaType: 'image' })).toEqual(
      new Set(['img', 'nsfw', 'lost']),
    )
    expect(match({ mediaType: 'video' }).size).toBe(0)
    expect(match({ mediaType: 'image,text' }).size).toBe(6)
    // An avatar never makes a collection sensitive.
    expect(match({ sensitive: 'contains' })).toEqual(new Set(['nsfw']))
    expect(match({ sensitive: 'not_contains' }).size).toBe(5)
    const future = new Date(Date.now() + 3_600_000).toISOString()
    expect(match({ savedFrom: future }).size).toBe(0)
    expect(match({ savedBefore: future }).size).toBe(6)
  })

  test('authors are stable identities labelled with their newest name', async () => {
    const { ctx } = setup({
      a1: byAuthor('a1', 'pa', '旧名'),
      a2: byAuthor('a2', 'pa', '旧名'),
      a3: byAuthor('a3', 'pa', '新名'),
      b1: byAuthor('b1', 'pb', '同名作者'),
      b2: byAuthor('b2', 'pb', '同名作者'),
      c1: byAuthor('c1', 'pc', '同名作者'),
      d1: byAuthor('d1', 'pd'),
      none: byAuthor('none'),
    })
    for (const id of ['a1', 'a2', 'a3', 'b1', 'b2', 'c1', 'd1', 'none'])
      await capture(ctx, post(id))
    const [pa, pb, pc, pd] = ['pa', 'pb', 'pc', 'pd'].map(
      (id) => `fake/fake.profile/${id}`,
    )
    // Most saved posts first, then by name.
    expect(listAuthors(ctx)).toEqual({
      items: [
        { id: pa, name: '新名', count: 3 },
        { id: pb, name: '同名作者', count: 2 },
        { id: pd, name: 'pd', count: 1 },
        { id: pc, name: '同名作者', count: 1 },
      ],
    })
    // Search reaches names and the platform's ids; keys name a selection.
    const found = (filter: Parameters<typeof listAuthors>[1]) =>
      listAuthors(ctx, filter).items.map((author) => author.id)
    expect(found({ q: '同名' })).toEqual([pb, pc])
    expect(found({ q: 'PD' })).toEqual([pd])
    expect(found({ authors: [pc!, pa!] })).toEqual([pa, pc])
    expect(listAuthors(ctx, { cursor: '4' }).items).toEqual([])
    for (const filter of [
      { cursor: '-1' },
      { cursor: '01' },
      { cursor: 'x' },
      { authors: ['新名'] },
    ])
      expect(() => listAuthors(ctx, filter)).toThrow(
        'invalid collection filters',
      )
    expect(all(ctx, { authors: [pa!] })).toHaveLength(3)
    expect(all(ctx, { authors: [pb!, pc!] })).toHaveLength(3)
    expect(all(ctx, { authors: [pc!] })).toHaveLength(1)
    for (const key of [
      '新名',
      'fake/fake.profile',
      'fake/fake.profile/pa/extra',
      'fake//pa',
      'fake/fake.profile/p%61',
    ])
      expect(() => listCollections(ctx, { authors: [key] })).toThrow(
        'invalid collection filters',
      )
  })

  test("visibility is the author's newest profile; tags reach their posts", async () => {
    const { ctx } = setup({
      p1: () => ({
        text: 'by a locked account',
        graph: graph(
          [
            entity('root', 'fake.post', 'p1'),
            entity('author', 'fake.profile', '300', { name: 'Locked' }),
          ],
          ['root', 'authored_by', 'author'],
        ),
      }),
      p2: () => ({
        text: 'by an open account',
        graph: graph(
          [
            entity('root', 'fake.post', 'p2'),
            entity('author', 'fake.profile', '301', {
              metadata: { protected: false },
            }),
          ],
          ['root', 'authored_by', 'author'],
        ),
      }),
      p3: byAuthor('p3', '302'),
      300: () => ({
        text: 'locked profile',
        graph: graph([
          entity('root', 'fake.profile', '300', {
            metadata: { protected: true },
          }),
        ]),
      }),
    })
    const p1 = (await capture(ctx, post('p1'))).collectionId
    const p2 = (await capture(ctx, post('p2'))).collectionId
    await capture(ctx, post('p3'))
    const locked = (await capture(ctx, profile('300'))).collectionId
    expect(
      ids(all(ctx, { visibility: 'private', entityType: 'fake.post' })),
    ).toEqual([p1])
    expect(ids(all(ctx, { visibility: 'private' })).toSorted()).toEqual(
      [p1, locked].toSorted(),
    )
    // Unknown is never public.
    expect(ids(all(ctx, { visibility: 'public' }))).toEqual([p2])

    const tag = updateAnnotation(ctx.db, locked, { tagNames: ['t'] }).tags[0]!
    expect(ids(all(ctx, { tag: tag.id, entityType: 'fake.post' }))).toEqual([
      p1,
    ])
    updateAnnotation(ctx.db, p2, { tagIds: [tag.id] })
    expect(ids(all(ctx, { tag: tag.id })).toSorted()).toEqual(
      [p1, p2, locked].toSorted(),
    )
  })

  test('related collections need direct edges from or to the root', async () => {
    let page = true
    const { ctx } = setup({
      'handle:friend': () => ({
        text: 'profile',
        canonicalTarget: {
          url: profile('500'),
          platform: 'fake',
          kind: 'profile',
          objectScope: '',
          externalId: '500',
          collection: true,
          refreshOnSubmit: true,
        },
        graph: graph([entity('root', 'fake.profile', '500')]),
      }),
      500: () => ({
        text: page ? 'first page' : 'later page',
        graph: page
          ? graph(
              [
                entity('root', 'fake.profile', '500'),
                // Known to the profile only by a provisional id.
                entity('post', 'fake.post', 'ralias'),
                entity('member', 'fake.post', 'c1'),
              ],
              ['root', 'reposted', 'post'],
              ['root', 'contains', 'member'],
            )
          : graph([entity('root', 'fake.profile', '500', { later: true })]),
      }),
      ralias: () => ({
        text: 'reposted',
        canonicalTarget: {
          url: post('r1'),
          platform: 'fake',
          kind: 'post',
          objectScope: '',
          externalId: 'r1',
          collection: false,
          refreshOnSubmit: false,
        },
        graph: graph([entity('root', 'fake.post', 'r1')]),
      }),
      c1: () => ({
        text: 'member',
        graph: graph([entity('root', 'fake.post', 'c1')]),
      }),
      ...Object.fromEntries(
        (
          [
            ['e1', '500', [['root', 'authored_by', 'profile']]],
            // By the alias, from the root and from its author.
            [
              'e2',
              'handle:friend',
              [
                ['root', 'mentions', 'profile'],
                ['author', 'mentions', 'profile'],
              ],
            ],
            // The author's bio mentions the profile: not the post.
            [
              'e3',
              '500',
              [
                ['root', 'authored_by', 'author'],
                ['author', 'mentions', 'profile'],
              ],
            ],
            // A quoted post's author is indirect context.
            [
              'e4',
              '500',
              [
                ['root', 'quoted', 'quote'],
                ['quote', 'authored_by', 'profile'],
              ],
            ],
            // Presence in the graph alone is no edge.
            ['e5', '500', []],
          ] as [string, string, [string, string, string][]][]
        ).map(([id, target, relations]) => [
          id,
          () => ({
            text: id,
            graph: graph(
              [
                entity('root', 'fake.post', id),
                entity('profile', 'fake.profile', target),
                entity('author', 'fake.profile', 'other'),
                entity('quote', 'fake.post', 'q9'),
              ],
              ...relations,
            ),
          }),
        ]),
      ),
    })
    const owner = (await capture(ctx, profile('friend'))).collectionId
    const saved: Record<string, string> = {}
    for (const id of ['e1', 'e2', 'e3', 'e4', 'e5', 'ralias', 'c1'])
      saved[id] = (await capture(ctx, post(id))).collectionId
    expect((await capture(ctx, profile('500'))).collectionId).toBe(owner)
    page = false
    await capture(ctx, profile('500'))

    const related = listCollections(ctx, {
      relatedTo: owner,
      entityType: 'fake.post',
    })
    const kinds = Object.fromEntries(
      related.items.map((c) => [
        Object.entries(saved).find(([, id]) => id === c.id)![0],
        c.relation_types,
      ]),
    )
    expect(kinds).toEqual({
      e1: ['authored_by'],
      e2: ['mentions'],
      ralias: ['reposted'],
      c1: ['contains'],
    })
    expect(related.total_storage_bytes).toBe(
      related.items.reduce((n, c) => n + c.storage_bytes!, 0),
    )
    expect(
      ids(all(ctx, { postType: 'quote', entityType: 'fake.post' })),
    ).toEqual([saved.e4])
    expect(
      ids(
        all(ctx, {
          relatedTo: owner,
          postType: 'repost',
          entityType: 'fake.post',
        }),
      ),
    ).toEqual([saved.ralias])
    expect(
      ids(
        all(ctx, {
          relatedTo: owner,
          postType: 'post',
          entityType: 'fake.post',
        }),
      ).toSorted(),
    ).toEqual([saved.e1, saved.e2, saved.c1].toSorted())
  })
})
