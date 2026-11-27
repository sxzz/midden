import { afterEach, describe, expect, test } from 'vitest'
import { createApi, SESSION_COOKIE } from '#http/app.ts'
import { createSession } from '#http/sessions.ts'
import { capture, entity, graph, libraryContext } from '#testing/library.ts'
import { adminId } from '#users/users.ts'
import { BUSY_DEBOUNCE, DEBOUNCE, FolderCountSweep } from './folder-counts.ts'
import { createFolder, listFolders, updateFolder } from './folders.ts'
import type { AccountsContext } from '#accounts/accounts.ts'
import type { CaptureContext } from '#capture/context.ts'

let ctx: CaptureContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

function setup() {
  const made = libraryContext((req) => ({
    text: `post ${req.externalId}`,
    graph: graph([entity('root', 'fake.post', req.externalId)]),
  }))
  ctx = made.ctx
  let now = 1_000_000
  const sweep = new FolderCountSweep(made.ctx.db, { now: () => now })
  return {
    c: made.ctx,
    sweep,
    later: (ms: number) => (now += ms),
  }
}

const post = (id: string) => `https://fake.test/p/${id}`
const shown = (c: CaptureContext) =>
  listFolders(c.db).map((f) => ({ count: f.count, stale: f.stale }))

describe('folder counts', () => {
  test('are counted again in the background once the library changed', async () => {
    const { c, sweep, later } = setup()
    await capture(c, post('1'))
    createFolder(c.db, { name: 'all', filter: '' })
    expect(shown(c)).toEqual([{ count: null, stale: true }])
    expect(await sweep.run()).toBe(1)
    expect(shown(c)).toEqual([{ count: 1, stale: false }])
    // Nothing changed: nothing to count.
    later(DEBOUNCE)
    expect(await sweep.run()).toBe(0)

    await capture(c, post('2'))
    // The list answers what was stored, saying it is out of date.
    expect(shown(c)).toEqual([{ count: 1, stale: true }])
    expect(await sweep.run()).toBe(1)
    expect(shown(c)).toEqual([{ count: 2, stale: false }])
  })

  test('are counted again at most every so often while the library changes', async () => {
    const { c, sweep, later } = setup()
    createFolder(c.db, { name: 'all', filter: '' })
    await sweep.run()
    await capture(c, post('1'))
    expect(await sweep.run()).toBe(1)
    await capture(c, post('2'))
    later(DEBOUNCE - 1000)
    expect(await sweep.run()).toBe(0)
    expect(shown(c)).toEqual([{ count: 1, stale: true }])
    later(1000)
    expect(await sweep.run()).toBe(1)
    expect(shown(c)).toEqual([{ count: 2, stale: false }])

    // While the worker is busy, less often.
    await capture(c, post('3'))
    later(DEBOUNCE)
    expect(await sweep.run({ busy: true })).toBe(0)
    later(BUSY_DEBOUNCE - DEBOUNCE)
    expect(await sweep.run({ busy: true })).toBe(1)
    expect(shown(c)).toEqual([{ count: 3, stale: false }])
  })

  test('a new or edited folder is counted at once, alone', async () => {
    const { c, sweep, later } = setup()
    await capture(c, post('1'))
    const all = createFolder(c.db, { name: 'all', filter: '' })
    const some = createFolder(c.db, { name: 'some', filter: 'q=nothing' })
    await sweep.run()
    await capture(c, post('2'))
    await sweep.run()
    await capture(c, post('3'))
    // Within the wait, the edited folder is counted; the other one waits.
    later(1000)
    updateFolder(c.db, some.id, { filter: 'q=post' })
    expect(listFolders(c.db).find((f) => f.id === some.id)).toMatchObject({
      stale: true,
    })
    expect(await sweep.run()).toBe(1)
    const folders = new Map(listFolders(c.db).map((f) => [f.id, f]))
    expect(folders.get(some.id)).toMatchObject({ count: 3, stale: false })
    expect(folders.get(all.id)).toMatchObject({ count: 2, stale: true })
  })

  test('the folders request never counts; a write counts its folder', async () => {
    const { c, sweep } = setup()
    await capture(c, post('1'))
    createFolder(c.db, { name: 'a', filter: 'q=post' })
    createFolder(c.db, { name: 'b', filter: 'saved_within=7d' })
    await sweep.run()
    await capture(c, post('2'))
    const api = createApi({
      ctx: c as AccountsContext,
      webAppUrl: 'https://midden.test/',
    })
    const session = createSession(c.db, adminId(c.db))
    const call = (path: string, init: RequestInit = {}) =>
      api.request(path, {
        ...init,
        headers: {
          Cookie: `${SESSION_COOKIE}=${session}`,
          Origin: 'https://midden.test',
          'Content-Type': 'application/json',
        },
      })
    // Every statement the request prepares.
    const prepared: string[] = []
    const client = c.db.$client
    const prepare = client.prepare.bind(client)
    client.prepare = ((text: string) => {
      prepared.push(text)
      return prepare(text)
    }) as typeof client.prepare
    try {
      const response = await call('/folders')
      expect(response.status).toBe(200)
      expect(
        ((await response.json()) as { count: number; stale: boolean }[]).map(
          (f) => [f.count, f.stale],
        ),
      ).toEqual([
        [1, true],
        [1, true],
      ])
      expect(prepared.length).toBeGreaterThan(0)
      expect(prepared.filter((text) => /count\(/i.test(text))).toEqual([])

      prepared.length = 0
      const made = await call('/folders', {
        method: 'POST',
        body: JSON.stringify({ name: 'c', filter: 'q=post' }),
      })
      expect(await made.json()).toMatchObject({ count: 2, stale: false })
      expect(prepared.some((text) => /count\(/i.test(text))).toBe(true)
    } finally {
      client.prepare = prepare
    }
  })
})
