import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { backup } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, describe, expect, test } from 'vitest'
import { createFolder } from '#library/folders.ts'
import { createShare } from '#library/shares.ts'
import { QueryPool, READ_THREAD } from '#reads/pool.ts'
import { agentFixture, type AgentFixture } from '#testing/agent.ts'
import { testContext } from '#testing/context.ts'
import { createApi, SESSION_COOKIE } from './app.ts'
import { createSession } from './auth.ts'
import {
  pooledWebReads,
  type ForwardedRequest,
  type WebReads,
} from './offload.ts'
import type { AccountsContext } from '#accounts/accounts.ts'
import type { ReadThreadData } from '#reads/thread.ts'

let pool: QueryPool | undefined
let fixture: AgentFixture | undefined
let ctx: AccountsContext | undefined
afterEach(async () => {
  await pool?.close()
  pool = undefined
  await fixture?.ctx.queue.stop()
  fixture = undefined
  await ctx?.queue.stop()
  ctx = undefined
})

/** The API over `ctx`, signed in as the owner. */
function signedIn(
  api: ReturnType<typeof createApi>,
  db: AccountsContext['db'],
) {
  const session = createSession(db)
  return (route: string, init: RequestInit = {}) =>
    api.request(route, {
      ...init,
      headers: {
        Cookie: `${SESSION_COOKIE}=${session}`,
        Origin: 'https://midden.test',
        'Content-Type': 'application/json',
        ...init.headers,
      },
    })
}

describe('GET requests on the read threads', () => {
  /** Reads that answer every forwarded request with what it was. */
  function echoReads() {
    const forwarded: ForwardedRequest[] = []
    const reads: WebReads = {
      run: async (request) => {
        forwarded.push(request)
        return {
          status: 200,
          headers: [['content-type', 'application/json']],
          body: new TextEncoder().encode(JSON.stringify({ thread: true }))
            .buffer as ArrayBuffer,
        }
      },
    }
    return { reads, forwarded }
  }

  test('go to the threads unless their route says inline', async () => {
    ctx = testContext()
    const { reads, forwarded } = echoReads()
    const call = signedIn(
      createApi({ ctx, reads, webAppUrl: 'https://midden.test/app/' }),
      ctx.db,
    )

    const list = await call('/captures?cursor=x')
    expect(await list.json()).toEqual({ thread: true })
    // The login was checked here; the thread gets what it found, and no
    // cookie or token.
    expect(forwarded).toMatchObject([
      { base: '/', url: 'http://localhost/captures?cursor=x', session: true },
    ])
    expect(forwarded[0]!.headers.map(([name]) => name)).not.toContain('cookie')
    // Answered by this process: the session check, the platforms, a write.
    expect((await call('/session')).status).toBe(204)
    expect(await (await call('/accounts')).json()).toMatchObject({
      accounts: [],
    })
    const folder = await call('/folders', {
      method: 'POST',
      body: JSON.stringify({ name: 'All', filter: '' }),
    })
    expect(folder.status).toBe(200)
    // An unknown path is not worth a thread.
    expect((await call('/nothing-here')).status).toBe(404)
    expect(forwarded).toHaveLength(1)
    // Mounted as the web process mounts it, under an app with an error
    // handler of its own, which wraps the routes' handlers.
    const outer = new Hono().onError(
      () => new Response('outer', { status: 500 }),
    )
    outer.route(
      '/v1',
      createApi({ ctx, reads, webAppUrl: 'https://midden.test/app/' }),
    )
    const session = createSession(ctx.db)
    const mounted = (route: string) =>
      outer.request(route, {
        headers: { Cookie: `${SESSION_COOKIE}=${session}` },
      })
    expect(await (await mounted('/v1/accounts')).json()).toMatchObject({
      accounts: [],
    })
    expect(await (await mounted('/v1/captures')).json()).toEqual({
      thread: true,
    })
    expect(forwarded.at(-1)).toMatchObject({
      base: '/v1',
      url: 'http://localhost/v1/captures',
    })
    forwarded.pop()
    // Without a login nothing is read.
    expect((await createApi({ ctx, reads }).request('/captures')).status).toBe(
      401,
    )
    expect(forwarded).toHaveLength(1)
  })

  test('public links read on the threads without a login', async () => {
    ctx = testContext()
    const { reads, forwarded } = echoReads()
    const api = createApi({ ctx, reads })
    expect((await api.request('/public/some-slug')).status).toBe(200)
    expect(forwarded).toMatchObject([
      { url: 'http://localhost/public/some-slug', session: false },
    ])
  })

  test('every write tells what the threads keep is out of date', async () => {
    ctx = testContext()
    let writes = 0
    const call = signedIn(
      createApi({
        ctx,
        webAppUrl: 'https://midden.test/app/',
        onWrite: () => writes++,
      }),
      ctx.db,
    )
    await call('/folders')
    expect(writes).toBe(0)
    await call('/folders', {
      method: 'POST',
      body: JSON.stringify({ name: 'All', filter: '' }),
    })
    // Even one that failed: it may have written part of its work.
    await call('/folders', { method: 'POST', body: '{}' })
    expect(writes).toBe(2)
  })

  test('a thread answers them from its own connection, as this process would', async () => {
    fixture = await agentFixture()
    const source = fixture.ctx
    createFolder(source.db, { name: 'Cats', filter: 'q=cat' })
    const share = createShare(source.db, {
      target: 'collection',
      id: fixture.ids.p1!,
    })
    const file = path.join(
      mkdtempSync(path.join(tmpdir(), 'midden-offload-')),
      'db',
    )
    await backup(source.db.$client, file)
    pool = new QueryPool({
      script: READ_THREAD,
      workerData: {
        databasePath: file,
        mediaDir: path.join(tmpdir(), 'unused'),
        // The test context signs media with this key.
        mediaKey: new TextEncoder().encode('test'),
        types: fixture.reader.types,
      } satisfies ReadThreadData,
    })
    // This process's database is empty: what comes back was read there.
    ctx = testContext()
    const pooled = signedIn(
      createApi({ ctx, reads: pooledWebReads(pool) }),
      ctx.db,
    )
    const inline = signedIn(createApi({ ctx: source }), source.db)
    const record = (await (await inline('/captures')).json()) as {
      items: { id: string }[]
    }
    const routes = [
      '/collections',
      '/collections?q=cat',
      '/collections/count?q=cat',
      '/collections/authors',
      `/collections/${fixture.ids.p2}`,
      `/collections/${fixture.ids['7']}/history`,
      '/folders',
      '/captures',
      `/captures/${record.items[0]!.id}`,
      `/captures/${record.items[0]!.id}/members`,
      '/library',
      '/tags',
      '/usage',
      '/shares',
      `/public/${share.slug}`,
    ]
    for (const route of routes) {
      const there = await pooled(route)
      const here = await inline(route)
      expect([route, there.status]).toEqual([route, here.status])
      expect([route, await there.json()]).toEqual([route, await here.json()])
    }
    expect((await pooled('/collections')).headers.get('Cache-Control')).toBe(
      'no-store',
    )
    // An error is answered as here.
    expect((await pooled('/collections/nope')).status).toBe(404)

    // Every GET route works there: none needs what only this process has.
    const capture = (
      source.db.$client
        .prepare('SELECT id FROM captures WHERE collection_id = ?')
        .get(fixture.ids.p1!) as { id: string }
    ).id
    const params: Record<string, string> = {
      id: fixture.ids.p1!,
      slug: share.slug,
      capture,
    }
    const gets = createApi({ ctx: source })
      .routes.filter((r) => r.method === 'GET' && !r.path.includes('*'))
      .map((r) =>
        r.path.replaceAll(/:(\w+)/g, (_, name: string) => params[name]!),
      )
    expect(gets.length).toBeGreaterThan(40)
    for (const route of new Set(gets)) {
      const response = await pooled(route)
      expect([route, response.status < 500]).toEqual([route, true])
    }
  }, 30_000)
})
