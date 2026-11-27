import { afterEach, expect, test } from 'vitest'
import { createApi } from '#http/app.ts'
import { createSession, SESSION_COOKIE } from '#http/sessions.ts'
import { capture, entity, graph, libraryContext } from '#testing/library.ts'
import { updateAnnotation } from './annotations.ts'
import { createFolder } from './folders.ts'
import { suggest } from './suggest.ts'
import type { AccountsContext } from '#accounts/accounts.ts'
import type { FetchResponse } from '#platforms/protocol.ts'

const AUTHORS: Record<string, { username: string; name: string }> = {
  '1': { username: 'alice', name: 'Alice' },
  '2': { username: 'albert', name: 'Albert' },
  '3': { username: 'bob', name: 'Bob' },
}
const POSTS: Record<string, { author: string; text: string }> = {
  p1: { author: '1', text: '#cats at https://www.a.test/1' },
  p2: { author: '1', text: '#cats and #catnip https://music.a.test/2' },
  p3: { author: '2', text: '#catnip again https://b.test/3' },
  p4: { author: '3', text: 'nothing here' },
}

let ctx: AccountsContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

async function setup() {
  const made = libraryContext((req): Partial<FetchResponse> => {
    const post = POSTS[req.externalId]!
    const author = AUTHORS[post.author]!
    return {
      text: post.text,
      authorName: author.name,
      graph: graph(
        [
          entity('root', 'fake.post', req.externalId, { text: post.text }),
          entity('author', 'fake.profile', post.author, author),
        ],
        ['root', 'authored_by', 'author'],
      ),
    }
  })
  ctx = made.ctx as AccountsContext
  const ids: Record<string, string> = {}
  for (const id of Object.keys(POSTS))
    ids[id] = (await capture(ctx, `https://fake.test/p/${id}`)).collectionId
  return { c: ctx, ids }
}

test('offers what the library holds, most used first', async () => {
  const { c, ids } = await setup()
  updateAnnotation(c.db, ids.p1!, { tagNames: ['to read', 'art'] })
  updateAnnotation(c.db, ids.p2!, { tagNames: ['to read'] })
  createFolder(c.db, { name: '猫', query: '#cats' })
  createFolder(c.db, { name: 'art folder', query: 'tag:art' })

  expect(suggest(c.db, 'handle', '@al')).toEqual([
    { value: '@alice', label: 'Alice', count: 2 },
    { value: '@albert', label: 'Albert', count: 1 },
  ])
  // One or two letters are read row by row, and find the same.
  expect(suggest(c.db, 'handle', 'b').map((s) => s.value)).toEqual(['@bob'])
  // Nothing typed yet: the authors with the most posts.
  expect(suggest(c.db, 'handle', '')[0]).toEqual({
    value: '@alice',
    label: 'Alice',
    count: 2,
  })
  expect(suggest(c.db, 'hashtag', 'CAT')).toEqual([
    { value: 'catnip', count: 2 },
    { value: 'cats', count: 2 },
  ])
  expect(suggest(c.db, 'domain', 'a')).toEqual([{ value: 'a.test', count: 2 }])
  expect(suggest(c.db, 'tag', 'a')).toEqual([
    // Starts with it first, then holds it.
    { value: 'art', count: 1 },
    { value: 'to read', count: 2 },
  ])
  expect(suggest(c.db, 'tag', 'to')).toEqual([{ value: 'to read', count: 2 }])
  expect(suggest(c.db, 'folder', 'ART')).toEqual([{ value: 'art folder' }])
  expect(suggest(c.db, 'hashtag', 'zzz')).toEqual([])
})

test('the owner asks for them; nobody else', async () => {
  const { c } = await setup()
  const app = createApi({ ctx: c, webAppUrl: 'https://midden.test/app/' })
  const session = createSession(c.db)
  const ask = (query: string, signedIn = true) =>
    app.request(`/query/suggest?${query}`, {
      headers: signedIn ? { Cookie: `${SESSION_COOKIE}=${session}` } : {},
    })
  const answer = await ask('kind=hashtag&prefix=cat')
  expect(answer.status).toBe(200)
  expect(((await answer.json()) as { items: unknown[] }).items).toHaveLength(2)
  expect((await ask('kind=nope')).status).toBe(400)
  expect((await ask('kind=tag', false)).status).toBe(401)
})
