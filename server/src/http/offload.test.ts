import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { backup } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, describe, expect, test } from 'vitest'
import { createFolder } from '#library/folders.ts'
import { createShare } from '#library/shares.ts'
import { Platforms } from '#platforms/registry.ts'
import { QueryPool, READ_THREAD } from '#reads/pool.ts'
import { agentFixture, type AgentFixture } from '#testing/agent.ts'
import { testContext } from '#testing/context.ts'
import { fakePlatform } from '#testing/fake-platform.ts'
import { createApi, SESSION_COOKIE } from './app.ts'
import {
  inline as inlineRoute,
  pooledWebReads,
  type ForwardedRequest,
  type WebReads,
} from './offload.ts'
import { createSession } from './sessions.ts'
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
    // A platform that reads follows, as X does: the relation views look up
    // where its profiles keep their counts.
    const source: AccountsContext = {
      ...fixture.ctx,
      platforms: new Platforms([
        fakePlatform(
          { current: () => ({}) },
          { current: () => ({ accounts: [], nextCursor: '' }) },
        ),
      ]),
    }
    createFolder(source.db, { name: 'Cats', filter: 'q=cat' })
    const share = createShare(source.db, {
      target: 'collection',
      id: fixture.ids.p1!,
    })
    const profile = fixture.ids['7']!
    const profileShare = createShare(source.db, {
      target: 'collection',
      id: profile,
    })
    // Alice (7) and Bob (8) follow each other; Alice follows Carol (9), who
    // is not saved, and Bob followed her once.
    const db = source.db.$client
    const entityOf = (external: string) =>
      (
        db
          .prepare(
            `SELECT id FROM entities
            WHERE kind = 'fake.profile' AND external_id = ?`,
          )
          .get(external) as { id: string }
      ).id
    db.prepare(
      `INSERT INTO entities (id, platform, kind, external_id)
      VALUES ('carol', 'fake', 'fake.profile', '9')`,
    ).run()
    const follow = db.prepare(
      `INSERT INTO follow_edges
      (follower_id, followee_id, first_seen_at, last_seen_at, ended_at)
      VALUES (?, ?, 1000, 2000, ?)`,
    )
    follow.run(entityOf('7'), entityOf('8'), null)
    follow.run(entityOf('8'), entityOf('7'), null)
    follow.run(entityOf('7'), 'carol', null)
    follow.run(entityOf('8'), 'carol', 3000)
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
        countPointers: source.platforms.countPointers(),
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
    const alice = encodeURIComponent('fake/fake.profile/7')
    const bob = encodeURIComponent('fake/fake.profile/8')
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
      // The relation views, over follows.
      `/collections/graph?of=${alice}&kinds=following%2Cfollowers&limit=300`,
      `/collections/graph?of=${alice}&viewer=${bob}`,
      `/collections/${profile}/graph?kinds=mutual`,
      `/collections/${profile}/follows`,
      `/collections/${profile}/follow-changes`,
      `/collections/${profile}/counts`,
      `/collections/${profile}/profile-changes`,
      `/collections/compare?rel_of=${alice}&rel_of=${bob}`,
      `/collections/compare?rel_of=${alice}&rel_of=${bob}&rel=followers&rel_min=1`,
      '/collections/perspectives',
      `/collections/perspectives?rel_of=${alice}`,
      `/collections?rel_of=${alice}&rel=following`,
      `/collections/authors?rel_of=${alice}&rel=mutual`,
      `/public/${profileShare.slug}/collections/${profile}/graph`,
      `/public/${profileShare.slug}/collections/${profile}/follows`,
      `/public/${profileShare.slug}/collections/${profile}/follow-changes`,
    ]
    for (const route of routes) {
      const there = await pooled(route)
      const here = await inline(route)
      expect([route, here.status]).toEqual([route, 200])
      expect([route, there.status]).toEqual([route, here.status])
      expect([route, await there.json()]).toEqual([route, await here.json()])
    }
    // The graph found the follows, and the counts the profiles keep.
    const graph = (await (
      await pooled(`/collections/graph?of=${alice}`)
    ).json()) as { nodes: { key: string; followers?: number }[] }
    expect(graph.nodes.map((n) => [n.key, n.followers])).toEqual([
      ['fake/fake.profile/7', 120],
      ['fake/fake.profile/8', 30],
      ['fake/fake.profile/9', undefined],
    ])
    expect((await pooled('/collections')).headers.get('Cache-Control')).toBe(
      'no-store',
    )
    // An error is answered as here.
    expect((await pooled('/collections/nope')).status).toBe(404)

    // Every GET route works there, as here: none needs what only this
    // process has. Each is read for a post and for a profile with follows,
    // with the parameters it requires.
    const captureOf = (id: string) =>
      (
        db
          .prepare('SELECT id FROM captures WHERE collection_id = ?')
          .get(id) as { id: string }
      ).id
    const required: Record<string, string> = {
      '/collections/graph': `?of=${alice}`,
      '/collections/compare': `?rel_of=${alice}&rel_of=${bob}`,
    }
    const all = createApi({ ctx: source }).routes
    // Those answered here read this process's empty database.
    const here = new Set(
      all.filter((r) => r.handler === inlineRoute).map((r) => r.path),
    )
    const gets = all.filter(
      (r) => r.method === 'GET' && !r.path.includes('*') && !here.has(r.path),
    )
    expect(gets.length).toBeGreaterThan(40)
    for (const params of [
      { id: fixture.ids.p1!, slug: share.slug },
      { id: profile, slug: profileShare.slug },
    ]) {
      const values: Record<string, string> = {
        ...params,
        capture: captureOf(params.id),
      }
      const urls = gets.map(
        (r) =>
          r.path.replaceAll(/:(\w+)/g, (_, name: string) => values[name]!) +
          (required[r.path] ?? ''),
      )
      for (const route of new Set(urls)) {
        const there = await pooled(route)
        expect([route, there.status < 500]).toEqual([route, true])
        expect([route, there.status]).toEqual([
          route,
          (await inline(route)).status,
        ])
      }
    }
  }, 30_000)
})
