import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { backup } from 'node:sqlite'
import { Hono } from 'hono'
import { afterEach, describe, expect, test } from 'vitest'
import { typeCatalog } from '#agent/runner.ts'
import { createFolder, type Folder } from '#library/folders.ts'
import { createShare } from '#library/shares.ts'
import { Platforms } from '#platforms/registry.ts'
import { QueryPool, READ_THREAD } from '#reads/pool.ts'
import { agentFixture, type AgentFixture } from '#testing/agent.ts'
import { testContext } from '#testing/context.ts'
import { fakePlatform } from '#testing/fake-platform.ts'
import { createToken } from '#tokens/tokens.ts'
import { adminId } from '#users/users.ts'
import { createApi, SESSION_COOKIE } from './app.ts'
import {
  inline as inlineRoute,
  namedReads,
  pooledWebReads,
  readOnly as readOnlyRoute,
  type ForwardedRequest,
  type NamedRead,
  type WebReads,
} from './offload.ts'
import { createSession } from './sessions.ts'
import type { AccountsContext } from '#accounts/accounts.ts'
import type { ReadName } from '#agent/reads.ts'
import type { ReadThreadData } from '#reads/thread.ts'
import type { Principal } from '#users/principal.ts'

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
  const session = createSession(db, adminId(db))
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
  /**
   * Reads that answer every forwarded request with what it was, and run
   * reads by name in place, noting each.
   */
  function echoReads(over?: AccountsContext) {
    const forwarded: ForwardedRequest[] = []
    const named: string[] = []
    const inPlace = namedReads(undefined, () => ({
      db: over!.db,
      blobs: over!.blobs,
      types: typeCatalog(over!.platforms),
    }))
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
      read: ((principal: Principal, name: ReadName, input: never) => {
        named.push(name)
        return inPlace(principal, name, input)
      }) as NamedRead,
    }
    return { reads, forwarded, named }
  }

  test('go to the threads unless their route says inline', async () => {
    ctx = testContext()
    const { reads, forwarded } = echoReads(ctx)
    const call = signedIn(
      createApi({ ctx, reads, webAppUrl: 'https://midden.test/app/' }),
      ctx.db,
    )

    const list = await call('/captures?cursor=x')
    expect(await list.json()).toEqual({ thread: true })
    // The login was checked here; the thread gets what it found, and no
    // cookie or token.
    expect(forwarded).toMatchObject([
      {
        base: '/',
        url: 'http://localhost/captures?cursor=x',
        principal: { userId: adminId(ctx.db), role: 'admin', via: 'session' },
      },
    ])
    expect(forwarded[0]!.headers.map(([name]) => name)).not.toContain('cookie')
    // Answered by this process: the session check, the platforms, a write.
    expect((await call('/session')).status).toBe(200)
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
    const session = createSession(ctx.db, adminId(ctx.db))
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

  test('dry runs go there too; writes stay, and read there first', async () => {
    ctx = testContext()
    const { reads, forwarded, named } = echoReads(ctx)
    let writes = 0
    const api = createApi({
      ctx,
      reads,
      webAppUrl: 'https://midden.test/app/',
      onWrite: () => writes++,
    })
    const call = signedIn(api, ctx.db)
    const id = '01a20bf5-66fb-71af-a240-f6335db4ef76'
    const dryRuns: [string, unknown][] = [
      ['/updates/preview', { target: { target: 'folder', id } }],
      ['/media-removals/preview', { ids: [id] }],
      [`/collections/${id}/video-removal/preview`, undefined],
      ['/collections/delete/preview', { ids: [id], with_posts: true }],
    ]
    for (const [route, body] of dryRuns) {
      const response = await call(route, {
        method: 'POST',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      expect([route, await response.json()]).toEqual([route, { thread: true }])
      const sent = forwarded.at(-1)!
      expect(sent).toMatchObject({
        method: 'POST',
        url: `http://localhost${route}`,
        principal: expect.objectContaining({ role: 'admin', via: 'session' }),
      })
      expect(
        body === undefined
          ? sent.body
          : JSON.parse(new TextDecoder().decode(sent.body)),
      ).toEqual(body)
    }
    // None is a write the threads hear of.
    expect(writes).toBe(0)
    // A read-only token may run them, and no write.
    const ro = createToken(ctx.db, {
      user: adminId(ctx.db),
      label: 'ro',
      permission: 'ro',
    }).secret
    const asToken = (route: string, body: unknown) =>
      api.request(route, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ro}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })
    expect((await asToken(...dryRuns[0]!)).status).toBe(200)
    expect(
      (await asToken('/folders', { name: 'All', filter: '' })).status,
    ).toBe(403)
    forwarded.length = 0
    // A write runs here, and what it reads first runs as a read by name.
    const folder = await call('/folders', {
      method: 'POST',
      body: JSON.stringify({ name: 'All', filter: '' }),
    })
    expect(folder.status).toBe(200)
    const started = await call('/updates', {
      method: 'POST',
      body: JSON.stringify({
        target: { target: 'folder', id: ((await folder.json()) as Folder).id },
      }),
    })
    // The folder is empty: the plan says so, as the write would.
    expect(await started.json()).toMatchObject({ error: '收藏夹是空的' })
    expect(forwarded).toEqual([])
    expect(named).toEqual(['folderCounts', 'updatePlan'])
    expect(writes).toBe(3)
  })

  test('public links read on the threads without a login', async () => {
    ctx = testContext()
    const { reads, forwarded } = echoReads(ctx)
    const api = createApi({ ctx, reads })
    expect((await api.request('/public/some-slug')).status).toBe(200)
    expect(forwarded).toMatchObject([
      { url: 'http://localhost/public/some-slug', principal: undefined },
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

    // So does every dry run (`readOnly`), answering as here, for a post and
    // for a profile; each takes the body given here, so a new one needs one.
    const bodies: Record<string, (id: string) => unknown> = {
      '/updates/preview': (id) => ({ target: { target: 'collection', id } }),
      '/media-removals/preview': (id) => ({ ids: [id] }),
      '/collections/:id/video-removal/preview': () => undefined,
      '/collections/delete/preview': (id) => ({ ids: [id], with_posts: true }),
    }
    const dryRuns = all.filter((r) => r.handler === readOnlyRoute)
    expect(dryRuns.map((r) => `${r.method} ${r.path}`).toSorted()).toEqual(
      Object.keys(bodies)
        .map((path) => `POST ${path}`)
        .toSorted(),
    )
    for (const id of [fixture.ids.p4!, profile])
      for (const r of dryRuns) {
        const route = r.path.replace(':id', id)
        const body = bodies[r.path]!(id)
        const init = {
          method: 'POST',
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }
        const there = await pooled(route, init)
        const answer = await inline(route, init)
        expect([route, there.status]).toEqual([route, answer.status])
        expect([route, await there.json()]).toEqual([
          route,
          await answer.json(),
        ])
      }
  }, 30_000)

  test('writes read on a thread first, and write here', async () => {
    fixture = await agentFixture()
    const folder = createFolder(fixture.ctx.db, { name: 'All', filter: '' })
    const file = path.join(
      mkdtempSync(path.join(tmpdir(), 'midden-offload-')),
      'db',
    )
    await backup(fixture.ctx.db.$client, file)
    // This process writes the file the threads read.
    ctx = testContext({
      file,
      platforms: [fakePlatform({ current: () => ({}) })],
    })
    pool = new QueryPool({
      script: READ_THREAD,
      workerData: {
        databasePath: file,
        mediaDir: path.join(tmpdir(), 'unused'),
        mediaKey: new TextEncoder().encode('test'),
        types: fixture.reader.types,
        countPointers: ctx.platforms.countPointers(),
      } satisfies ReadThreadData,
    })
    const call = signedIn(
      createApi({
        ctx,
        reads: pooledWebReads(pool),
        webAppUrl: 'https://midden.test/app/',
      }),
      ctx.db,
    )
    const post = (route: string, body?: unknown) =>
      call(route, {
        method: 'POST',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    const { ids } = fixture
    // An update of the folder: its members as the thread read them.
    const started = await post('/updates', {
      target: { target: 'folder', id: folder.id },
      options: { posts: 'none' },
    })
    const record = (await started.json()) as {
      id: string
      paused?: boolean
      update: { posts: number; profiles: number }
    }
    expect(record.update).toMatchObject({ posts: 4, profiles: 2 })
    const update = () =>
      ctx!.db.$client
        .prepare('SELECT state, paused_at FROM updates WHERE id = ?')
        .get(record.id) as { state: string; paused_at: number | null }
    expect(
      (
        (await (await post(`/updates/${record.id}/pause`)).json()) as {
          paused?: boolean
        }
      ).paused,
    ).toBe(true)
    expect(update().paused_at).not.toBeNull()
    expect(
      (await (await post(`/updates/${record.id}/resume`)).json()) as object,
    ).not.toHaveProperty('paused')
    expect((await post(`/captures/${record.id}/stop`)).status).toBe(204)
    expect(update().state).toBe('stopped')
    // Started again, as a new record.
    const again = (await (
      await post(`/captures/${record.id}/retry`)
    ).json()) as { record_id: string }
    expect(again.record_id).not.toBe(record.id)
    // Media removed as planned there.
    const preview = await (
      await post('/media-removals/preview', {
        ids: [ids.p4!],
      })
    ).json()
    expect(preview).toMatchObject({ media: 1 })
    expect(
      await (await post('/media-removals', { ids: [ids.p4!] })).json(),
    ).toEqual(preview)
    expect(
      ctx.db.$client
        .prepare(
          `SELECT a.state FROM assets a JOIN captures c ON c.id = a.capture_id
          WHERE c.collection_id = ? AND a.purpose = ''`,
        )
        .all(ids.p4!),
    ).toEqual([{ state: 'removed' }])
    // An account deleted with its posts, as counted there.
    const counts = await (
      await post('/collections/delete/preview', {
        ids: [ids['7']!],
        with_posts: true,
      })
    ).json()
    expect(
      await (
        await post('/collections/delete', {
          ids: [ids['7']!],
          with_posts: true,
        })
      ).json(),
    ).toEqual(counts)
    expect(
      ctx.db.$client
        .prepare('SELECT collection_id FROM library WHERE collection_id = ?')
        .get(ids['7']!),
    ).toBeUndefined()
    // What a read there throws is answered as if thrown here.
    const missing = await post('/updates', {
      target: { target: 'folder', id: '01a20bf5-66fb-71af-a240-f6335db4ef76' },
    })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: '内容不存在或已删除' })
  }, 30_000)
})
