import { afterEach, describe, expect, test } from 'vitest'
import { testContext } from '#testing/context.ts'
import { tokenSecret } from '#testing/tokens.ts'
import { TokenUsage } from '#tokens/usage.ts'
import { adminId } from '#users/users.ts'
import { createApi, SESSION_COOKIE } from './app.ts'
import { createSession } from './sessions.ts'
import type { AccountsContext } from '#accounts/accounts.ts'

const WEB = 'https://midden.test/app/'
const ORIGIN = new URL(WEB).origin
const ID = '01234567-89ab-cdef-0123-456789abcdef'

let ctx: AccountsContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

function setup({ dev = false } = {}) {
  ctx = testContext()
  const usage = new TokenUsage({ db: ctx.db })
  const app = createApi({ ctx, webAppUrl: WEB, dev, tokenUsage: usage })
  const session = createSession(ctx.db, adminId(ctx.db))
  const request = (
    path: string,
    auth: { token?: string; session?: boolean },
    init: { method?: string; body?: unknown } = {},
  ) =>
    app.request(path, {
      method: init.method ?? 'GET',
      headers: {
        ...(auth.token ? { Authorization: `Bearer ${auth.token}` } : {}),
        ...(auth.session
          ? { Cookie: `${SESSION_COOKIE}=${session}`, Origin: ORIGIN }
          : {}),
        'Content-Type': 'application/json',
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
  return { ctx, app, usage, request }
}

/**
 * Every route that deletes, and adding or removing a domain: the admin's
 * session alone (`adminSession`). A domain is where cookie sessions write
 * from and passkeys are made.
 */
const ADMIN_SESSION: [string, string, unknown?][] = [
  ['DELETE', `/collections/${ID}`],
  ['POST', '/collections/delete', { ids: [ID] }],
  ['POST', '/media-removals', { ids: [ID] }],
  ['POST', `/collections/${ID}/video-removal`],
  ['DELETE', `/tags/${ID}`],
  ['DELETE', `/folders/${ID}`],
  ['DELETE', `/origins/${ID}`],
  ['DELETE', `/watches/${ID}`],
  ['POST', '/library/delete-all', { confirm: 'delete all' }],
  ['POST', '/origins', { origin: 'https://new.test' }],
  // Users and invites: a token cannot make a link that registers.
  ['GET', '/users'],
  ['PATCH', `/users/${ID}`, { name: 'x' }],
  ['POST', `/users/${ID}/revoke`],
  ['DELETE', `/users/${ID}`],
  ['GET', '/invites'],
  ['POST', '/invites', { label: 'x' }],
  ['DELETE', `/invites/${ID}`],
]

/**
 * Every route that makes or changes a way in (tokens, sessions, passkeys):
 * a session alone, each user's for their own (`sessionOnly`).
 */
const SESSION_ONLY: [string, string, unknown?][] = [
  ['GET', '/tokens'],
  ['POST', '/tokens', { label: 'x', permission: 'ro', expires_at: null }],
  ['PATCH', `/tokens/${ID}`, { label: 'x' }],
  ['POST', `/tokens/${ID}/roll`],
  ['GET', `/tokens/${ID}/usage`],
  ['DELETE', `/tokens/${ID}`],
  ['GET', '/sessions'],
  ['POST', '/sessions/revoke-others'],
  ['DELETE', `/sessions/${ID}`],
  // A token that could add a passkey could sign in with it, and so make
  // itself a session.
  ['GET', '/passkeys'],
  ['POST', '/passkeys/options'],
  ['POST', '/passkeys', { name: 'x', response: { id: 'x', response: {} } }],
  ['PATCH', `/passkeys/${ID}`, { name: 'x' }],
  ['DELETE', `/passkeys/${ID}`],
]

/** No token gets past either. */
const SESSION_ALONE = [...ADMIN_SESSION, ...SESSION_ONLY]

/**
 * Where tokens, sessions, passkeys, domains, users and invites are
 * managed. A new route here must join `ADMIN_SESSION` or `SESSION_ONLY`.
 */
const CREDENTIALS =
  /^\/(?:tokens|sessions|passkeys|origins|users|invites)(?:\/|$)/
/** The one such route a token may call: it changes nothing, shows no secret. */
const TOKEN_ALLOWED = new Set(['GET /origins'])

describe('API tokens on /v1', () => {
  test('a read-only token reads; a read and write token writes', async () => {
    const { request } = setup()
    const ro = tokenSecret(ctx!.db, 'ro')
    const rw = tokenSecret(ctx!.db, 'rw')
    expect((await request('/tags', { token: ro })).status).toBe(200)
    const write = (token: string) =>
      request(
        '/folders',
        { token },
        {
          method: 'POST',
          body: { name: 'cats', filter: 'q=cat' },
        },
      )
    const refused = await write(ro)
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({ error: '只读令牌不能修改内容' })
    expect((await write(rw)).status).toBe(200)
  })

  test('no token can delete or manage tokens, sessions, passkeys or domains; the session can', async () => {
    const { request } = setup()
    const rw = tokenSecret(ctx!.db, 'rw')
    const ro = tokenSecret(ctx!.db, 'ro')
    for (const [method, path, body] of SESSION_ALONE) {
      for (const token of [rw, ro]) {
        const response = await request(path, { token }, { method, body })
        expect({ method, path, status: response.status }).toEqual({
          method,
          path,
          status: 403,
        })
      }
      // The session gets past the guard: whatever else it answers.
      const owned = await request(path, { session: true }, { method, body })
      expect({ method, path, guarded: owned.status === 403 }).toEqual({
        method,
        path,
        guarded: path === '/library/delete-all',
      })
    }
  })

  test('every route that manages tokens, sessions, passkeys or domains is for the session alone', async () => {
    const { app, request } = setup()
    const listed = new Set(
      SESSION_ALONE.map(
        ([method, path]) => `${method} ${path.replaceAll(ID, ':id')}`,
      ),
    )
    const routes = [
      ...new Set(
        app.routes
          .filter((r) => r.method !== 'ALL' && CREDENTIALS.test(r.path))
          .map((r) => `${r.method} ${r.path}`),
      ),
    ]
    expect(routes.length).toBeGreaterThan(15)
    for (const route of routes)
      expect([route, listed.has(route) || TOKEN_ALLOWED.has(route)]).toEqual([
        route,
        true,
      ])
    // And the guard comes first: a token is refused before the body is read.
    const rw = tokenSecret(ctx!.db, 'rw')
    for (const route of routes.filter((r) => !TOKEN_ALLOWED.has(r))) {
      const [method, path] = route.split(' ') as [string, string]
      const response = await request(
        path.replaceAll(/:\w+/g, ID),
        { token: rw },
        { method },
      )
      expect([route, response.status]).toEqual([route, 403])
    }
  })

  test('a read and write token unshares and removes capture accounts: they delete no content', async () => {
    const { request } = setup()
    const rw = tokenSecret(ctx!.db, 'rw')
    const ro = tokenSecret(ctx!.db, 'ro')
    const folder = (await (
      await request(
        '/folders',
        { token: rw },
        {
          method: 'POST',
          body: { name: 'cats', filter: 'q=cat' },
        },
      )
    ).json()) as { id: string }
    const share = (await (
      await request(
        '/shares',
        { token: rw },
        {
          method: 'POST',
          body: { target: 'folder', id: folder.id },
        },
      )
    ).json()) as { id: string }
    const unshare = (token: string) =>
      request(`/shares/${share.id}`, { token }, { method: 'DELETE' })
    expect((await unshare(ro)).status).toBe(403)
    expect((await unshare(rw)).status).toBe(204)
    expect(await (await request('/shares', { token: rw })).json()).toEqual([])
    // Past the permission check: there is no such account.
    const remove = (token: string) =>
      request(`/accounts/${ID}`, { token }, { method: 'DELETE' })
    expect((await remove(ro)).status).toBe(403)
    expect((await remove(rw)).status).toBe(404)
  })

  test('on a development server a read and write token stands in for the session', async () => {
    const { request } = setup({ dev: true })
    const rw = tokenSecret(ctx!.db, 'rw')
    const ro = tokenSecret(ctx!.db, 'ro')
    expect((await request('/tokens', { token: rw })).status).toBe(200)
    expect((await request('/passkeys', { token: rw })).status).toBe(200)
    expect(
      (
        await request(
          '/library/delete-all',
          { token: rw },
          {
            method: 'POST',
            body: { confirm: 'delete all' },
          },
        )
      ).status,
    ).toBe(200)
    expect((await request('/tokens', { token: ro })).status).toBe(403)
  })

  test('an expired or unknown token is refused, and the session is not affected', async () => {
    const { request } = setup()
    const made = await request(
      '/tokens',
      { session: true },
      {
        method: 'POST',
        body: {
          label: 'soon',
          permission: 'ro',
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
      },
    )
    const { token, secret } = (await made.json()) as {
      token: { id: string }
      secret: string
    }
    expect((await request('/tags', { token: secret })).status).toBe(200)
    ctx!.db.run(`UPDATE api_tokens SET expires_at = 1 WHERE id = '${token.id}'`)
    const expired = await request('/tags', { token: secret })
    expect(expired.status).toBe(401)
    expect(await expired.json()).toEqual({ error: '令牌已过期' })
    expect((await request('/tags', { token: 'md_nope' })).status).toBe(401)
    expect((await request('/tags', { session: true })).status).toBe(200)
  })
})

describe('设置 → API 令牌', () => {
  test('makes, lists, edits, rolls and revokes tokens', async () => {
    const { request, usage } = setup()
    const owner = { session: true }
    const expiresAt = new Date(Date.now() + 7 * 24 * 3_600_000).toISOString()
    const made = await request('/tokens', owner, {
      method: 'POST',
      body: { label: '研究', permission: 'ro', expires_at: expiresAt },
    })
    expect(made.status).toBe(200)
    const { token, secret } = (await made.json()) as {
      token: { id: string }
      secret: string
    }
    expect(secret).toMatch(/^mdn_ro_/)
    expect(token).toEqual({
      id: expect.any(String),
      label: '研究',
      permission: 'ro',
      created_at: expect.any(String),
      expires_at: expiresAt,
      expired: false,
      last_used_at: null,
      usage: { today: 0, total: 0, days: expect.any(Array) },
    })

    // Its use shows at once, written or not.
    await request('/tags', { token: secret })
    await request('/tags', { token: secret })
    const [listed] = (await (await request('/tokens', owner)).json()) as {
      usage: { today: number }
      last_used_at: string | null
    }[]
    expect(listed.usage.today).toBe(2)
    expect(listed.last_used_at).not.toBeNull()
    usage.flush()
    expect(
      await (await request(`/tokens/${token.id}/usage`, owner)).json(),
    ).toEqual({
      days: expect.any(Array),
      endpoints: [{ endpoint: 'GET /tags', count: 2 }],
    })

    const never = await request(`/tokens/${token.id}`, owner, {
      method: 'PATCH',
      body: { expires_at: null, label: '研究 2' },
    })
    expect(await never.json()).toEqual(
      expect.objectContaining({ label: '研究 2', expires_at: null }),
    )
    const past = await request(`/tokens/${token.id}`, owner, {
      method: 'PATCH',
      body: { expires_at: '2020-01-01T00:00:00Z' },
    })
    expect(past.status).toBe(400)
    expect(await past.json()).toEqual({ error: '过期时间必须晚于现在' })

    const rolled = (await (
      await request(`/tokens/${token.id}/roll`, owner, { method: 'POST' })
    ).json()) as {
      token: { id: string; usage: { total: number } }
      secret: string
    }
    expect(rolled.token.id).toBe(token.id)
    expect(rolled.token.usage.total).toBe(2)
    expect((await request('/tags', { token: secret })).status).toBe(401)
    expect((await request('/tags', { token: rolled.secret })).status).toBe(200)

    expect(
      (await request(`/tokens/${token.id}`, owner, { method: 'DELETE' }))
        .status,
    ).toBe(204)
    expect(await (await request('/tokens', owner)).json()).toEqual([])
    expect((await request('/tags', { token: rolled.secret })).status).toBe(401)
  })
})
