import { afterEach, describe, expect, test } from 'vitest'
import { testContext } from '#testing/context.ts'
import { tokenSecret } from '#testing/tokens.ts'
import { TokenUsage } from '#tokens/usage.ts'
import { createApi, SESSION_COOKIE } from './app.ts'
import { createSession } from './auth.ts'
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
  const session = createSession(ctx.db)
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

/** Every route that deletes, and token management: the session's alone. */
const OWNER_ONLY: [string, string, unknown?][] = [
  ['DELETE', `/collections/${ID}`],
  ['POST', '/collections/delete', { ids: [ID] }],
  ['POST', '/media-removals', { ids: [ID] }],
  ['POST', `/collections/${ID}/video-removal`],
  ['DELETE', `/tags/${ID}`],
  ['DELETE', `/folders/${ID}`],
  ['DELETE', `/shares/${ID}`],
  ['DELETE', `/accounts/${ID}`],
  ['DELETE', `/passkeys/${ID}`],
  ['DELETE', `/origins/${ID}`],
  ['DELETE', `/watches/${ID}`],
  ['POST', '/library/delete-all', { confirm: 'delete all' }],
  ['GET', '/tokens'],
  ['POST', '/tokens', { label: 'x', permission: 'ro', expires_at: null }],
  ['PATCH', `/tokens/${ID}`, { label: 'x' }],
  ['POST', `/tokens/${ID}/roll`],
  ['GET', `/tokens/${ID}/usage`],
  ['DELETE', `/tokens/${ID}`],
]

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

  test('no token can delete or manage tokens; the session can', async () => {
    const { request } = setup()
    const rw = tokenSecret(ctx!.db, 'rw')
    const ro = tokenSecret(ctx!.db, 'ro')
    for (const [method, path, body] of OWNER_ONLY) {
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

  test('on a development server a read and write token stands in for the session', async () => {
    const { request } = setup({ dev: true })
    const rw = tokenSecret(ctx!.db, 'rw')
    const ro = tokenSecret(ctx!.db, 'ro')
    expect((await request('/tokens', { token: rw })).status).toBe(200)
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
