import { afterEach, expect, test } from 'vitest'
import { capture, entity, graph, libraryContext } from '#testing/library.ts'
import { listCollections } from './list.ts'
import { collectionScope, folderScope } from './share-scope.ts'
import type { CaptureContext } from '#capture/context.ts'
import type { FetchResponse } from '#platforms/protocol.ts'

let ctx: CaptureContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

const post = (id: string) => `https://fake.test/p/${id}`
const profile = (id: string) => `https://fake.test/u/${id}`

// The related-list cases of list.test.ts, aliases included: a profile known
// by a handle first, a reposted post saved under another id.
let page = true
const routes: Record<string, () => Partial<FetchResponse>> = {
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
        [
          'e2',
          'handle:friend',
          [
            ['root', 'mentions', 'profile'],
            ['author', 'mentions', 'profile'],
          ],
        ],
        [
          'e3',
          '500',
          [
            ['root', 'authored_by', 'author'],
            ['author', 'mentions', 'profile'],
          ],
        ],
        [
          'e4',
          '500',
          [
            ['root', 'quoted', 'quote'],
            ['quote', 'authored_by', 'profile'],
          ],
        ],
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
}

test("a folder's profiles bring exactly the posts their page lists", async () => {
  page = true
  const made = libraryContext((req) => {
    const route = routes[req.externalId]
    if (!route) throw new Error(`no route for ${req.externalId}`)
    return route()
  })
  ctx = made.ctx
  const owner = (await capture(ctx, profile('friend'))).collectionId
  const saved: Record<string, string> = {}
  for (const id of ['e1', 'e2', 'e3', 'e4', 'e5', 'ralias', 'c1'])
    saved[id] = (await capture(ctx, post(id))).collectionId
  await capture(ctx, profile('500'))
  page = false
  await capture(ctx, profile('500'))

  const listed = listCollections(ctx, {
    relatedTo: owner,
    entityType: 'fake.post',
  }).items.map((item) => item.id)
  expect(listed.length).toBe(4)
  const all = Object.values(saved)
  for (const scope of [
    folderScope(ctx.db, 'entity_type=fake.profile'),
    collectionScope(ctx.db, owner),
  ]) {
    expect([...scope.contains(all)].toSorted()).toEqual(listed.toSorted())
    for (const id of all)
      expect(scope.contains([id]).has(id)).toBe(listed.includes(id))
    expect(scope.contains([owner]).has(owner)).toBe(true)
    expect(scope.profilePosts(owner)).toEqual({
      relatedTo: owner,
      entityType: 'fake.post',
    })
    expect(scope.profilePosts(saved.e1!)).toBeUndefined()
  }
  // A single post reaches nothing else.
  const single = collectionScope(ctx.db, saved.e1!)
  expect([...single.contains([...all, owner])]).toEqual([saved.e1])
  expect(single.profilePosts(saved.e1!)).toBeUndefined()
})
