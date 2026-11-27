import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, test } from 'vitest'
import { captureHandlers } from '#capture/handlers.ts'
import { watchLitestream, type LitestreamWatch } from '#litestream.ts'
import { testContext } from '#testing/context.ts'
import { fakePlatform, fakeProfile, postGraph } from '#testing/fake-platform.ts'
import { tokenSecret } from '#testing/tokens.ts'
import { adminId } from '#users/users.ts'
import { createApi, SESSION_COOKIE } from './app.ts'
import { createSession } from './sessions.ts'
import type { AccountsContext } from '#accounts/accounts.ts'

const BOT = '123:secret-token'
const OWNER = '42'
const WEB = 'https://midden.test/'

const NO_LITESTREAM = {
  enabled: false,
  last_heartbeat_at: null,
  stale: false,
  stale_after_minutes: null,
}

let ctx: AccountsContext | undefined
let watch: LitestreamWatch | undefined
afterEach(async () => {
  watch?.close()
  watch = undefined
  await ctx?.queue.stop()
  ctx = undefined
})

function setup({
  dev = false,
  litestream,
}: { dev?: boolean; litestream?: boolean } = {}) {
  ctx = testContext({
    platforms: [
      fakePlatform({
        current: (req) =>
          req.kind === 'profile'
            ? fakeProfile(req.externalId)
            : { text: 'post', graph: postGraph(req.externalId, {}) },
      }),
    ],
    handlers: captureHandlers,
  })
  ctx.queue.start()
  watch = litestream
    ? watchLitestream({
        db: ctx.db,
        host: '127.0.0.1',
        port: 0,
        logger: ctx.logger,
        notify: () => {},
      })
    : undefined
  const app = createApi({
    ctx,
    telegram: { token: BOT, owner: OWNER },
    webAppUrl: WEB,
    dev,
    litestream: watch,
  })
  // The owner in the web app, signed in: what most of the API is for.
  const session = createSession(ctx.db, adminId(ctx.db))
  const call = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        Cookie: `${SESSION_COOKIE}=${session}`,
        Origin: new URL(WEB).origin,
        'Content-Type': 'application/json',
        ...init.headers,
      },
    })
  /** The same with an API token instead of the session. */
  const withToken =
    (permission: 'ro' | 'rw') =>
    (path: string, init: RequestInit = {}) => {
      const token = tokenSecret(ctx!.db, permission)
      return app.request(path, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...init.headers,
        },
      })
    }
  return { ctx, app, call, watch, withToken }
}

function initData(user: number, authDate = Math.floor(Date.now() / 1000)) {
  const fields: Record<string, string> = {
    auth_date: String(authDate),
    query_id: 'q',
    user: JSON.stringify({ id: user, first_name: 'Me' }),
  }
  const check = Object.keys(fields)
    .toSorted()
    .map((key) => `${key}=${fields[key]}`)
    .join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(BOT).digest()
  const hash = createHmac('sha256', secret).update(check).digest('hex')
  return new URLSearchParams({ ...fields, hash }).toString()
}

describe('api', () => {
  test('requires a token or session', async () => {
    const { app } = setup()
    expect((await app.request('/captures')).status).toBe(401)
    expect(
      (
        await app.request('/captures', {
          headers: { Authorization: 'Bearer nope' },
        })
      ).status,
    ).toBe(401)
  })

  test('answers the web app’s origins with CORS, preflights before login', async () => {
    const { app, call } = setup()
    const web = new URL(WEB).origin
    const preflight = (origin: string) =>
      app.request('/captures', {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type',
        },
      })
    // No cookie and no token: a preflight never reaches the login check.
    const allowed = await preflight(web)
    expect(allowed.status).toBe(204)
    expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe(web)
    expect(allowed.headers.get('Access-Control-Allow-Credentials')).toBe('true')
    expect(allowed.headers.get('Access-Control-Max-Age')).toBe('7200')
    expect(allowed.headers.get('Access-Control-Allow-Methods')).toContain(
      'DELETE',
    )
    expect(
      (await preflight('https://elsewhere.test')).headers.get(
        'Access-Control-Allow-Origin',
      ),
    ).toBeNull()

    // Answers and errors alike, so the web app can read either.
    const read = await call('/captures')
    expect(read.status).toBe(200)
    expect(read.headers.get('Access-Control-Allow-Origin')).toBe(web)
    expect(read.headers.get('Vary')).toContain('Origin')
    const refused = await app.request('/captures', { headers: { Origin: web } })
    expect(refused.status).toBe(401)
    expect(refused.headers.get('Access-Control-Allow-Origin')).toBe(web)
    expect(refused.headers.get('Access-Control-Allow-Credentials')).toBe('true')
  })

  test('submits, lists and tracks captures', async () => {
    const { ctx, call } = setup()
    const submitted = await call('/captures', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://fake.test/p/1' }),
    })
    expect(submitted.status).toBe(200)
    const job = (await submitted.json()) as {
      id: string
      state: string
      record_id: string
    }
    expect(job.state).toBe('queued')
    await ctx.queue.drain()
    expect(await (await call(`/jobs/${job.id}`)).json()).toMatchObject({
      id: job.id,
      state: 'complete',
    })
    const records = (await (await call('/captures')).json()) as {
      items: { id: string }[]
    }
    expect(records.items).toHaveLength(1)
    expect(records.items[0]!.id).toBe(job.record_id)
    expect(
      await (await call(`/captures/${records.items[0]!.id}`)).json(),
    ).toMatchObject({
      job_id: job.id,
      state: 'complete',
      warnings: [],
      media_items: [],
    })
    expect(await (await call('/library')).json()).toMatchObject({
      collections: 1,
    })
    const { collection_id: collectionId } = (await (
      await call(`/jobs/${job.id}`)
    ).json()) as { collection_id: string }
    expect(
      await (await call(`/collections/${collectionId}/availability`)).json(),
    ).toEqual({ available: true })
    // An update is a record of its own, opened by the id it answers with.
    const update = (await (
      await call('/updates', {
        method: 'POST',
        body: JSON.stringify({
          target: { target: 'collection', id: collectionId },
        }),
      })
    ).json()) as { id: string }
    expect(update.id).not.toBe(job.record_id)
    await ctx.queue.drain()
    // Its record says what it ran with: the defaults, none given.
    expect(await (await call(`/captures/${update.id}`)).json()).toMatchObject({
      id: update.id,
      update: { target: 'collection', posts: 1, profiles: 0, older: false },
      options: {
        posts: 'latest',
        count: 100,
        media_only: false,
        include_shared: true,
        capture_references: true,
        relations: false,
      },
      done: true,
    })
    expect(
      await (await call(`/collections/${collectionId}/update`)).json(),
    ).toEqual({ record: { id: update.id, done: true }, older: false })
    // Only a profile's timeline the post cap stopped reads on.
    const more = await call(`/updates/${update.id}/continue`, {
      method: 'POST',
      body: JSON.stringify({ collection_id: collectionId }),
    })
    expect(more.status).toBe(404)

    // Several at once, counted first.
    const remove = (body: object) =>
      call('/collections/delete', {
        method: 'POST',
        body: JSON.stringify(body),
      })
    const counts = {
      profiles: 0,
      posts: 1,
      related: 0,
      kept: { listed: 0, saved: 0, annotated: 0, quoted: 0 },
    }
    const dry = await call('/collections/delete/preview', {
      method: 'POST',
      body: JSON.stringify({ ids: [collectionId], with_posts: true }),
    })
    expect(await dry.json()).toEqual(counts)
    expect((await remove({ ids: [] })).status).toBe(400)
    expect(
      await (await remove({ ids: [collectionId], with_posts: true })).json(),
    ).toEqual(counts)
    expect((await remove({ ids: [collectionId] })).status).toBe(404)
  })

  test('maps errors to the statuses and texts the web app knows', async () => {
    const { call } = setup()
    const bad = await call('/captures', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://example.com/x' }),
    })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: '不支持的链接' })
    const missing = await call('/captures/nope')
    expect(missing.status).toBe(404)
    const invalid = await call('/captures', {
      method: 'POST',
      body: '{"url":1}',
    })
    expect(invalid.status).toBe(400)
    // Both ways to start a capture take the same options, checked alike.
    for (const options of [
      { posts: 'all' },
      { count: 0 },
      { since_days: 3 },
      { posts: 'until_existing', count: 5 },
      { max_posts: 5 },
    ]) {
      const link = await call('/captures', {
        method: 'POST',
        body: JSON.stringify({ url: 'https://fake.test/u/1', options }),
      })
      expect(link.status).toBe(400)
      const update = await call('/updates', {
        method: 'POST',
        body: JSON.stringify({
          target: { target: 'many', ids: [] },
          options,
        }),
      })
      expect(update.status).toBe(400)
    }
  })

  test('only the owner logs in, and sessions write only from the web app', async () => {
    const { app } = setup()
    const login = (data: string, origin = new URL(WEB).origin) =>
      app.request('/auth/telegram', {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ init_data: data }),
      })
    expect((await login(initData(7))).status).toBe(403)
    expect((await login(initData(42), 'https://evil.test')).status).toBe(403)
    expect((await login(initData(42, 1000))).status).toBe(401)
    const ok = await login(initData(42))
    expect(ok.status).toBe(200)
    const cookie = ok.headers.get('set-cookie')!.split(';', 1)[0]!
    expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true)
    expect(
      (await app.request('/session', { headers: { Cookie: cookie } })).status,
    ).toBe(200)
    const write = (origin?: string) =>
      app.request('/captures', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/json',
          ...(origin ? { Origin: origin } : {}),
        },
        body: JSON.stringify({ url: 'https://fake.test/p/1' }),
      })
    expect((await write()).status).toBe(403)
    expect((await write(new URL(WEB).origin)).status).toBe(200)
    await app.request('/session', {
      method: 'DELETE',
      headers: { Cookie: cookie, Origin: new URL(WEB).origin },
    })
    expect(
      (await app.request('/session', { headers: { Cookie: cookie } })).status,
    ).toBe(401)
  })

  test('accounts can be added, selected and removed', async () => {
    const { call } = setup()
    const added = await call('/accounts', {
      method: 'POST',
      body: JSON.stringify({ platform: 'fake', credential: 'alice' }),
    })
    const account = (await added.json()) as { id: string }
    expect(account).toMatchObject({
      name: '采集账号',
      username: 'fake',
      state: 'ready',
      platform: 'fake',
      selected: true,
    })
    const { id } = account
    expect(await (await call('/accounts')).json()).toMatchObject({
      platforms: [
        { id: 'fake', public: true, can_add: true, selected_account_id: id },
      ],
      accounts: [{ id, name: '采集账号', state: 'ready', selected: true }],
    })
    expect((await call(`/accounts/${id}`, { method: 'DELETE' })).status).toBe(
      204,
    )
    expect(await (await call('/accounts')).json()).toMatchObject({
      accounts: [],
    })
  })

  test('shows Litestream and edits its heartbeat timeout only when configured', async () => {
    const put = (call: ReturnType<typeof setup>['call'], body: unknown) =>
      call('/instance/litestream', {
        method: 'PUT',
        body: JSON.stringify(body),
      })
    const without = setup()
    expect((await put(without.call, { stale_after_minutes: 5 })).status).toBe(
      404,
    )
    await ctx!.queue.stop()

    const { call, watch } = setup({ litestream: true })
    expect(await (await call('/instance')).json()).toMatchObject({
      litestream: {
        enabled: true,
        last_heartbeat_at: null,
        stale: false,
        stale_after_minutes: 20,
      },
    })
    watch!.beat()
    const saved = await put(call, { stale_after_minutes: 7 })
    expect(await saved.json()).toMatchObject({
      enabled: true,
      last_heartbeat_at: expect.any(String),
      stale: false,
      stale_after_minutes: 7,
    })
    expect(watch!.status().stale_after_minutes).toBe(7)
    for (const bad of [0, 1.5, 1441, '5', null, undefined])
      expect((await put(call, { stale_after_minutes: bad })).status).toBe(400)
    expect(watch!.status().stale_after_minutes).toBe(7)
  })

  test('deletes everything only in development mode', async () => {
    const save = async (call: ReturnType<typeof setup>['call']) => {
      await call('/captures', {
        method: 'POST',
        body: JSON.stringify({ url: 'https://fake.test/p/1' }),
      })
      await ctx!.queue.drain()
    }
    const clear = (call: ReturnType<typeof setup>['call']) =>
      call('/library/delete-all', {
        method: 'POST',
        body: JSON.stringify({ confirm: 'delete all' }),
      })
    const production = setup()
    await save(production.call)
    expect(await (await production.call('/instance')).json()).toEqual({
      dev: false,
      bot: 'off',
      litestream: NO_LITESTREAM,
    })
    const refused = await clear(production.call)
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({ error: '只在开发模式中可用' })
    expect(await (await production.call('/library')).json()).toMatchObject({
      collections: 1,
    })
    await ctx!.queue.stop()

    const dev = setup({ dev: true })
    await save(dev.call)
    expect(await (await dev.call('/instance')).json()).toEqual({
      dev: true,
      bot: 'off',
      litestream: NO_LITESTREAM,
    })
    expect(await (await clear(dev.call)).json()).toMatchObject({
      collections: 1,
    })
    expect(await (await dev.call('/library')).json()).toMatchObject({
      collections: 0,
    })
  })

  test('reads the library', async () => {
    const { ctx, call } = setup()
    await call('/captures', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://fake.test/p/1' }),
    })
    await ctx.queue.drain()
    const list = (await (await call('/collections')).json()) as {
      items: { id: string; text: string }[]
    }
    expect(list.items).toMatchObject([{ text: 'post' }])
    const id = list.items[0]!.id
    expect(await (await call(`/collections/${id}`)).json()).toMatchObject({
      id,
      graph: { root: 'post' },
    })
    const history = (await (
      await call(`/collections/${id}/history`)
    ).json()) as {
      items: { capture_id: string }[]
    }
    expect(history.items).toHaveLength(1)
    expect(
      (await call(`/collections/${id}/history/${history.items[0]!.capture_id}`))
        .status,
    ).toBe(200)
    for (const limit of ['', '?limit=2', '?limit=1000'])
      expect(
        await (await call(`/collections/${id}/counts${limit}`)).json(),
      ).toMatchObject({ points: expect.any(Array) })
    for (const limit of ['0', '1001', '2.5', 'all'])
      expect(
        (await call(`/collections/${id}/counts?limit=${limit}`)).status,
      ).toBe(400)
    // A post has no profile to change.
    for (const limit of ['', '?limit=1', '?limit=1000'])
      expect(
        await (await call(`/collections/${id}/profile-changes${limit}`)).json(),
      ).toEqual({ items: [] })
    for (const limit of ['0', '1001', 'all'])
      expect(
        (await call(`/collections/${id}/profile-changes?limit=${limit}`))
          .status,
      ).toBe(400)
    // Nor any follows: nothing is said rather than zeros.
    expect(await (await call(`/collections/${id}/follows`)).json()).toEqual({})
    expect(
      await (await call(`/collections/${id}/follow-changes?limit=1`)).json(),
    ).toEqual({ items: [] })
    expect(
      (await call(`/collections/${id}/follow-changes?limit=0`)).status,
    ).toBe(400)
    expect(
      await (
        await call(`/collections/${id}/graph?kinds=mutual,following&limit=5`)
      ).json(),
    ).toMatchObject({ nodes: [], edges: [], total: 0 })
    for (const query of ['kinds=friends', 'limit=0', 'limit=10001'])
      expect((await call(`/collections/${id}/graph?${query}`)).status).toBe(400)
    // Any account, by its key: one never stored is the empty graph.
    expect(
      await (
        await call('/collections/graph?of=fake/fake.profile/1&limit=5')
      ).json(),
    ).toMatchObject({ nodes: [], total: 0 })
    for (const query of ['', 'of=', 'of=fake/fake.post/1', 'of=x&limit=0'])
      expect((await call(`/collections/graph?${query}`)).status).toBe(400)
    // Updating it may ask for the lists, which only a profile has.
    const refreshed = await call('/updates', {
      method: 'POST',
      body: JSON.stringify({
        target: { target: 'collection', id },
        options: { relations: true },
      }),
    })
    expect(refreshed.status).toBe(200)
    expect(
      (
        await call('/updates', {
          method: 'POST',
          body: JSON.stringify({
            target: { target: 'collection', id },
            options: { posts: true },
          }),
        })
      ).status,
    ).toBe(400)
    expect((await call('/collections/authors')).status).toBe(200)
    expect((await call('/collections?sort=nonsense')).status).toBe(400)
    // One author or several: both are a filter, not a malformed query.
    // An author the archive does not have selects nothing.
    for (const authors of [
      'author=x/user/1',
      'author=x/user/1&author=x/user/2',
    ]) {
      const list = await call(`/collections?${authors}`)
      expect(list.status).toBe(200)
      expect(((await list.json()) as { items: unknown[] }).items).toEqual([])
      const count = await call(`/collections/count?${authors}`)
      expect(await count.json()).toEqual({ count: 0, types: {} })
    }
    expect((await call('/collections?tag=a&tag=b')).status).toBe(400)
    // The 关系 filter and the accounts it can look from.
    expect(
      (await call('/collections?rel_of=x%2Fx.profile%2F1&rel=mutual')).status,
    ).toBe(200)
    expect((await call('/collections?rel=mutual')).status).toBe(400)
    expect(await (await call('/collections/perspectives?q=a')).json()).toEqual({
      items: [],
    })
    expect((await call('/collections/perspectives?cursor=x')).status).toBe(400)
    // Several perspectives at once, and comparing them.
    const two = 'rel_of=x%2Fx.profile%2F1&rel_of=x%2Fx.profile%2F2'
    expect(
      (await call(`/collections?${two}&rel=following&rel_min=1`)).status,
    ).toBe(200)
    expect(
      await (await call(`/collections/compare?${two}&rel=followers`)).json(),
    ).toMatchObject({ items: [], total: 0, combos: [], edges: [] })
    for (const query of [
      '',
      `${two}&rel=mutual`,
      `${two}&rel_min=0`,
      `${two}&only=a`,
      `${two}&limit=0`,
    ])
      expect((await call(`/collections/compare?${query}`)).status).toBe(400)
  })

  test('saves library filters as folders', async () => {
    const { ctx, call } = setup()
    const send = (method: string, path: string, body: unknown) =>
      call(path, { method, body: JSON.stringify(body) })
    await send('POST', '/captures', { url: 'https://fake.test/p/1' })
    await ctx.queue.drain()

    const created = await send('POST', '/folders', {
      name: '帖子',
      filter: 'entity_type=fake.post&layout=album',
    })
    expect(created.status).toBe(200)
    const folder = (await created.json()) as { id: string }
    expect(folder).toMatchObject({
      name: '帖子',
      // A folder keeps the platform only; its tabs choose the kind.
      filter: 'entity_type=fake.post%2Cfake.profile',
      count: 1,
      created_at: expect.any(String),
      updated_at: expect.any(String),
    })
    await send('POST', '/folders', { name: '空', filter: 'q=nothing' })
    expect(await (await call('/folders')).json()).toMatchObject([
      { id: folder.id, count: 1, types: { 'fake.post': 1 } },
      { name: '空', count: 0, types: {} },
    ])
    // Any filter, saved or not, counts the same way.
    expect(
      await (
        await call('/collections/count?saved_within=7d&layout=album')
      ).json(),
    ).toEqual({ count: 1, types: { 'fake.post': 1 } })
    for (const query of ['sort=nonsense', 'saved_within=0d'])
      expect((await call(`/collections/count?${query}`)).status).toBe(400)
    // The list's posts in buckets, over the same filter.
    const top = (await (
      await call('/collections/aggregate?by=type&entity_type=fake.post')
    ).json()) as { by: string; total: number; buckets: { key: string }[] }
    expect(top).toMatchObject({ by: 'type', total: 1 })
    expect(top.buckets.map((b) => b.key)).toEqual(['original'])
    for (const query of [
      'by=nonsense',
      'by=author&limit=0',
      'by=author&sort=x',
    ])
      expect((await call(`/collections/aggregate?${query}`)).status).toBe(400)

    const renamed = await send('PATCH', `/folders/${folder.id}`, {
      name: '全部帖子',
    })
    expect(await renamed.json()).toMatchObject({
      name: '全部帖子',
      filter: 'entity_type=fake.post%2Cfake.profile',
    })
    const refiltered = await send('PATCH', `/folders/${folder.id}`, {
      filter: 'q=post&sort=saved',
    })
    expect(await refiltered.json()).toMatchObject({
      name: '全部帖子',
      filter: 'q=post&sort=saved',
      count: 1,
    })

    // The list's own rules, and its error text.
    for (const filter of ['sort=nonsense', 'tag=a&tag=b'])
      expect(
        await (await send('POST', '/folders', { name: 'x', filter })).json(),
      ).toEqual({ error: '筛选条件无效' })
    const duplicate = await send('POST', '/folders', {
      name: '空',
      filter: '',
    })
    expect(duplicate.status).toBe(409)
    expect(await duplicate.json()).toEqual({ error: '已有同名的收藏夹' })
    const blank = await send('POST', '/folders', { name: ' ', filter: '' })
    expect(blank.status).toBe(400)
    expect(await blank.json()).toEqual({
      error: '收藏夹名称不能为空，最多 64 字',
    })
    for (const body of [{ name: 'x' }, { name: 'x', filter: '', extra: 1 }])
      expect((await send('POST', '/folders', body)).status).toBe(400)

    expect(
      (await call(`/folders/${folder.id}`, { method: 'DELETE' })).status,
    ).toBe(204)
    expect(
      (await call(`/folders/${folder.id}`, { method: 'DELETE' })).status,
    ).toBe(404)
    expect(await (await call('/folders')).json()).toMatchObject([
      { name: '空' },
    ])
  })

  test('watches a profile or a folder (定期更新)', async () => {
    const { ctx, call } = setup()
    const send = (method: string, path: string, body?: unknown) =>
      call(path, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    const job = (await (
      await send('POST', '/captures', { url: 'https://fake.test/u/100' })
    ).json()) as { id: string }
    await ctx.queue.drain()
    const { collection_id: profile } = (await (
      await call(`/jobs/${job.id}`)
    ).json()) as { collection_id: string }

    const created = await send('PUT', '/watches', {
      target: 'collection',
      id: profile,
      every: { count: 1, unit: 'day' },
      time_zone: 'Asia/Tokyo',
      options: { posts: 'until_existing', relations: true },
    })
    expect(created.status).toBe(200)
    const watch = (await created.json()) as { id: string }
    expect(watch).toMatchObject({
      target: 'collection',
      target_id: profile,
      url: 'https://fake.test/u/100',
      every: { count: 1, unit: 'day' },
      time_zone: 'Asia/Tokyo',
      enabled: true,
      options: { posts: 'until_existing', relations: true, media_only: false },
      next_run_at: expect.any(String),
    })
    expect(watch).not.toHaveProperty('last_run')
    expect(
      await (await call(`/watches?target=collection&id=${profile}`)).json(),
    ).toMatchObject({ items: [{ id: watch.id }] })
    expect(
      await (await call(`/watches?target=folder&id=${profile}`)).json(),
    ).toEqual({ items: [] })

    expect(
      await (
        await send('PATCH', `/watches/${watch.id}`, {
          enabled: false,
          every: { count: 2, unit: 'month' },
          options: { posts: 'latest', count: 20 },
        })
      ).json(),
    ).toMatchObject({
      enabled: false,
      every: { count: 2, unit: 'month' },
      time_zone: 'Asia/Tokyo',
      options: { posts: 'latest', count: 20, relations: false },
    })
    // The old fixed choices, an unknown unit, too many, too often, a zone
    // that is none.
    for (const bad of [
      { frequency: 'daily' },
      { every: { count: 1, unit: 'fortnight' } },
      { every: { count: 1001, unit: 'day' } },
      { every: { count: 4, unit: 'minute' } },
      { every: { count: 1, unit: 'day' }, time_zone: 'Mars/Olympus' },
    ]) {
      const refused = await send('PUT', '/watches', {
        target: 'collection',
        id: profile,
        ...bad,
      })
      expect(refused.status).toBe(400)
    }
    expect(
      await (
        await send('PUT', '/watches', {
          target: 'collection',
          id: profile,
          every: { count: 3, unit: 'minute' },
        })
      ).json(),
    ).toEqual({ error: '间隔最短 5 分钟' })
    expect((await send('DELETE', `/watches/${watch.id}`)).status).toBe(204)
    expect((await send('DELETE', `/watches/${watch.id}`)).status).toBe(404)
    expect(await (await call('/watches')).json()).toEqual({ items: [] })
  })

  test('renames, merges and deletes tags', async () => {
    const { ctx, call } = setup()
    const send = (method: string, path: string, body?: unknown) =>
      call(path, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    await send('POST', '/captures', { url: 'https://fake.test/p/1' })
    await ctx.queue.drain()
    const { items } = (await (await call('/collections')).json()) as {
      items: { id: string }[]
    }
    const annotated = (await (
      await send('PATCH', `/collections/${items[0]!.id}/annotation`, {
        tag_names: ['甲', '乙'],
      })
    ).json()) as { tags: { id: string; name: string }[] }
    const a = annotated.tags.find((t) => t.name === '甲')!
    const b = annotated.tags.find((t) => t.name === '乙')!

    const renamed = await send('PATCH', `/tags/${a.id}`, { name: '丙' })
    expect(await renamed.json()).toEqual({
      tag: { id: a.id, name: '丙' },
      merged: false,
      moved: 0,
    })
    const merged = await send('PATCH', `/tags/${a.id}`, { name: '乙' })
    expect(await merged.json()).toEqual({
      tag: { id: b.id, name: '乙' },
      merged: true,
      moved: 0,
    })
    const blank = await send('PATCH', `/tags/${b.id}`, { name: ' ' })
    expect(blank.status).toBe(400)
    expect(await blank.json()).toEqual({ error: '标签名不能为空，最多 64 字' })
    expect((await send('PATCH', `/tags/${b.id}`, {})).status).toBe(400)
    expect((await send('DELETE', `/tags/${b.id}`)).status).toBe(204)
    expect((await send('DELETE', `/tags/${b.id}`)).status).toBe(404)
    expect(await (await call('/tags')).json()).toEqual([])
  })

  test('removes media and takes the removal back', async () => {
    const { ctx, call } = setup()
    await call('/captures', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://fake.test/p/1' }),
    })
    await ctx.queue.drain()
    const { items } = (await (await call('/collections')).json()) as {
      items: { id: string }[]
    }
    const post = (path: string, body: unknown) =>
      call(path, { method: 'POST', body: JSON.stringify(body) })
    const ids = items.map((item) => item.id)
    const nothing = { media: 0, freed_bytes: 0, shared: 0 }
    const preview = await post('/media-removals/preview', { ids })
    expect(await preview.json()).toEqual(nothing)
    expect(await (await post('/media-removals', { ids })).json()).toEqual(
      nothing,
    )
    expect((await post('/media-removals', { ids: [] })).status).toBe(400)
    expect(
      (
        await post('/media-removals', {
          collection: ids[0],
          asset: 'missing',
        })
      ).status,
    ).toBe(404)
    expect(
      (
        await post('/media-removals/restore', {
          collection: ids[0],
          asset: 'missing',
        })
      ).status,
    ).toBe(404)
  })

  test('removes a profile’s videos as a job and follows it', async () => {
    const { ctx, call } = setup()
    const capture = (url: string) =>
      call('/captures', { method: 'POST', body: JSON.stringify({ url }) })
    await capture('https://fake.test/u/1')
    await capture('https://fake.test/p/2')
    await ctx.queue.drain()
    const { items } = (await (await call('/collections')).json()) as {
      items: { id: string; url: string }[]
    }
    const profile = items.find((item) => item.url.includes('/u/'))!.id
    const post = items.find((item) => item.url.includes('/p/'))!.id
    const path = (id: string) => `/collections/${id}/video-removal`
    const nothing = {
      posts: 0,
      videos: 0,
      freed_bytes: 0,
      shared: 0,
      kept: { listed: 0, saved: 0, annotated: 0, quoted: 0 },
      elsewhere: 0,
    }
    const preview = await call(`${path(profile)}/preview`, { method: 'POST' })
    expect(await preview.json()).toEqual(nothing)
    // Only of a saved profile.
    for (const id of [post, 'missing']) {
      expect(
        (await call(`${path(id)}/preview`, { method: 'POST' })).status,
      ).toBe(404)
      expect((await call(path(id), { method: 'POST' })).status).toBe(404)
    }
    expect(await (await call(path(profile))).json()).toEqual({})
    const started = await call(path(profile), { method: 'POST' })
    expect(started.status).toBe(202)
    const { id } = (await started.json()) as { id: string }
    await ctx.queue.drain()
    expect(await (await call(path(profile))).json()).toEqual({
      removal: {
        id,
        state: 'complete',
        effect: nothing,
        removed: 0,
        created_at: expect.any(String),
        finished_at: expect.any(String),
      },
    })
  })
})
