import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, test } from 'vitest'
import { captureHandlers } from '#capture/handlers.ts'
import { testContext } from '#testing/context.ts'
import { fakePlatform, postGraph } from '#testing/fake-platform.ts'
import { accountRoutes } from './account-routes.ts'
import { createApi, SESSION_COOKIE } from './app.ts'
import { createToken } from './auth.ts'
import { captureRoutes } from './capture-routes.ts'
import { libraryRoutes } from './library-routes.ts'
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
  captureRoutes(app, ctx)
  accountRoutes(app, ctx)
  libraryRoutes(app, ctx)
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
    const job = (await submitted.json()) as { id: string; state: string }
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
  })

  test('maps errors to the statuses and texts the web app knows', async () => {
    const { call } = setup()
    const bad = await call('/captures', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://example.com/x' }),
    })
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: 'unsupported URL' })
    const missing = await call('/captures/nope')
    expect(missing.status).toBe(404)
    const invalid = await call('/captures', {
      method: 'POST',
      body: '{"url":1}',
    })
    expect(invalid.status).toBe(400)
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
    const { id } = (await added.json()) as { id: string }
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
    const revisions = (await (
      await call(`/collections/${id}/revisions`)
    ).json()) as {
      items: { id: string }[]
    }
    expect(revisions.items).toHaveLength(1)
    expect(
      (await call(`/collections/${id}/revisions/${revisions.items[0]!.id}`))
        .status,
    ).toBe(200)
    expect((await call('/collections/authors')).status).toBe(200)
    expect(await (await call(`/collections/${id}/sources`)).json()).toEqual([])
    expect((await call('/collections?sort=nonsense')).status).toBe(400)
  })
})
