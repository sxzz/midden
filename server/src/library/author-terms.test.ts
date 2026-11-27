import { afterEach, expect, test } from 'vitest'
import { capture, entity, graph, libraryContext } from '#testing/library.ts'
import { authorTerms } from './author-terms.ts'
import { catalogTypes } from './folder-query.ts'
import type { CaptureContext } from '#capture/context.ts'
import type { FetchResponse } from '#platforms/protocol.ts'

// Two accounts went by @twin; one handle is no valid term.
const AUTHORS: Record<string, { username: string; name: string }> = {
  '1': { username: 'Alice', name: 'Alice' },
  '2': { username: 'twin', name: 'Twin A' },
  '3': { username: 'twin', name: 'Twin B' },
  '4': { username: 'not a handle', name: 'Spaces' },
}

let ctx: CaptureContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

test('an author is named by the handle that names it alone, else by its key', async () => {
  ;({ ctx } = libraryContext((req): Partial<FetchResponse> => {
    const author = AUTHORS[req.externalId.slice(1)]!
    return {
      text: 'hello',
      authorName: author.name,
      graph: graph(
        [
          entity('root', 'fake.post', req.externalId, { text: 'hello' }),
          entity('author', 'fake.profile', req.externalId.slice(1), author),
        ],
        ['root', 'authored_by', 'author'],
      ),
    }
  }))
  for (const id of Object.keys(AUTHORS))
    await capture(ctx, `https://fake.test/p/p${id}`)
  const key = (id: string) => `fake/fake.profile/${id}`
  const terms = authorTerms(
    ctx.db,
    catalogTypes(ctx.db),
    ['1', '2', '3', '4', '9'].map(key),
  )
  expect(Object.fromEntries(terms)).toEqual({ [key('1')]: '@alice' })
})
