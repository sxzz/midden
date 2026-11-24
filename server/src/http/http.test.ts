import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, test } from 'vitest'
import { captureHandlers } from '#capture/handlers.ts'
import { testContext } from '#testing/context.ts'
import { fakePlatform, postGraph } from '#testing/fake-platform.ts'
import { createApi, SESSION_COOKIE } from './app.ts'
import { createToken } from './auth.ts'
import type { AccountsContext } from '#accounts/accounts.ts'

const BOT = '123:secret-token'
const OWNER = '42'
const WEB = 'https://midden.test/app/'

let ctx: AccountsContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

function setup() {
  ctx = testContext({
    platforms: [
      fakePlatform({
        current: (req) => ({
          text: 'post',
          graph: postGraph(req.externalId, {}),
        }),
      }),
    ],
    handlers: captureHandlers,
  })
  ctx.queue.start()
  const app = createApi({
    ctx,
    telegram: { token: BOT, owner: OWNER },
    webAppUrl: WEB,
  })
  const token = createToken(ctx.db, 'test')
  const call = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...init.headers,
      },
    })
  return { ctx, app, call }
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
    const dry = await remove({ ids: [collectionId], dry_run: true })
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
    ).toBe(204)
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
    for (const authors of [
      'author=x/user/1',
      'author=x/user/1&author=x/user/2',
    ])
      expect((await call(`/collections?${authors}`)).status).toBe(200)
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
      filter: 'entity_type=fake.post',
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

    const renamed = await send('PATCH', `/folders/${folder.id}`, {
      name: '全部帖子',
    })
    expect(await renamed.json()).toMatchObject({
      name: '全部帖子',
      filter: 'entity_type=fake.post',
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
})
