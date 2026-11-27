// Viewers (docs/design/multi-user.md): every route refuses them unless it
// says `viewers`, and which routes say it is fixed by the tables here. A
// new route is closed to viewers until it is classified.
import { afterEach, describe, expect, test } from 'vitest'
import { viewers } from '#http/auth.ts'
import { threadApi } from '#reads/thread.ts'
import { agentFixture, type AgentFixture } from '#testing/agent.ts'
import { addViewer } from '#testing/users.ts'
import { createToken } from '#tokens/tokens.ts'
import { adminId } from '#users/users.ts'
import { createApi, SESSION_COOKIE } from './app.ts'
import { isMarked } from './markers.ts'
import { createSession } from './sessions.ts'
import type { Database } from '#db/client.ts'
import type { Principal } from '#users/principal.ts'

const WEB = 'https://midden.test/app/'
const ORIGIN = new URL(WEB).origin
const ID = '01234567-89ab-cdef-0123-456789abcdef'

/**
 * `/v1` routes a viewer may call, with their session only. What the
 * library reads give them is filtered at its source by who asks
 * (`viewer-leaks.test.ts`).
 */
const V1_FOR_VIEWERS = [
  'GET /session',
  'DELETE /session',
  // The library: lists, counts, searches and what the query box offers,
  // with tag parameters refused and only shared folders.
  'GET /collections',
  'GET /collections/count',
  'GET /query/suggest',
  'GET /collections/authors',
  'GET /collections/perspectives',
  'GET /usage',
  'GET /folders',
  // Relations, a collection and its history.
  'GET /collections/compare',
  'GET /collections/graph',
  'GET /collections/:id',
  'GET /collections/:id/history',
  'GET /collections/:id/history/:capture',
  'GET /collections/:id/counts',
  'GET /collections/:id/profile-changes',
  'GET /collections/:id/follows',
  'GET /collections/:id/follow-changes',
  'GET /collections/:id/graph',
  'GET /entities/:id',
  // Their own passkeys, sessions and tokens.
  'GET /passkeys',
  'POST /passkeys/options',
  'POST /passkeys',
  'PATCH /passkeys/:id',
  'DELETE /passkeys/:id',
  'GET /sessions',
  'POST /sessions/revoke-others',
  'DELETE /sessions/:id',
  'GET /tokens',
  'POST /tokens',
  'PATCH /tokens/:id',
  'POST /tokens/:id/roll',
  'GET /tokens/:id/usage',
  'DELETE /tokens/:id',
]

/** Agent API routes a viewer's token may call: reads, filtered alike. */
const AGENT_FOR_VIEWERS = [
  'GET /whoami',
  'GET /posts',
  'GET /accounts',
  'POST /posts/batch',
  'POST /accounts/batch',
  'GET /posts/:id',
  'GET /accounts/:id',
  'GET /posts/:id/metrics',
  'GET /accounts/:id/metrics',
  'GET /posts/:id/context',
  'GET /accounts/:id/history',
  'GET /accounts/:id/relations',
  'GET /accounts/:id/relation-changes',
  'GET /aggregate',
  'GET /folders',
]

/** What needs no login, viewer or not. */
const OPEN = /^\/(?:auth|public)\//

let fixture: AgentFixture | undefined
afterEach(async () => {
  await fixture?.ctx.queue.stop()
  fixture = undefined
})

type Routes = { method: string; path: string; handler: unknown }[]

/** `METHOD /path` of every route, and of those that say `viewers`. */
function routesOf(routes: Routes, base = '') {
  const all = new Set<string>()
  const marked = new Set<string>()
  for (const r of routes) {
    if (r.method === 'ALL' || r.path.includes('*')) continue
    const key = `${r.method} ${r.path.slice(base.length)}`
    if (OPEN.test(r.path)) continue
    all.add(key)
    if (isMarked(r.handler, viewers)) marked.add(key)
  }
  return { all: [...all], marked: [...marked].toSorted() }
}

/** The rows of every table: what a refused request must leave as it was. */
function rows(db: Database): Record<string, number> {
  const tables = db.$client
    .prepare(
      `SELECT name FROM sqlite_schema WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'
        AND name NOT LIKE '%_cjk%'`,
    )
    .all()
    .map((row) => row.name as string)
  return Object.fromEntries(
    tables.map((name) => [
      name,
      Number(
        db.$client.prepare(`SELECT count(*) AS n FROM "${name}"`).get()!.n,
      ),
    ]),
  )
}

const fill = (path: string) => path.replaceAll(/:\w+/g, ID)

async function setup() {
  fixture = await agentFixture()
  const { ctx } = fixture
  const api = createApi({ ctx, webAppUrl: WEB })
  const viewer = addViewer(ctx.db)
  const request = (
    method: string,
    path: string,
    auth: { cookie?: string; token?: string },
    body: unknown = {},
  ) =>
    api.request(path, {
      method,
      headers: {
        Origin: ORIGIN,
        'Content-Type': 'application/json',
        ...(auth.cookie ? { Cookie: `${SESSION_COOKIE}=${auth.cookie}` } : {}),
        ...(auth.token ? { Authorization: `Bearer ${auth.token}` } : {}),
      },
      ...(method === 'GET' || method === 'HEAD'
        ? {}
        : { body: JSON.stringify(body) }),
    })
  const viewerToken = (permission: 'ro' | 'rw' = 'ro') =>
    createToken(ctx.db, { user: viewer, label: 'v', permission }).secret
  return { ...fixture, ctx, api, viewer, request, viewerToken }
}

describe('routes open to viewers', () => {
  test('are exactly the tables, on /v1 and the agent API', async () => {
    const { api, app } = await setup()
    expect(routesOf(api.routes).marked).toEqual(V1_FOR_VIEWERS.toSorted())
    expect(routesOf(app.routes, '/agent/v1').marked).toEqual(
      AGENT_FOR_VIEWERS.toSorted(),
    )
  })

  test('a viewer’s session: every other /v1 route is 403 before it reads its input or writes; the open ones answer', async () => {
    const { ctx, api, viewer, request } = await setup()
    const { all } = routesOf(api.routes)
    expect(all.length).toBeGreaterThan(80)
    const before = rows(ctx.db)
    for (const route of all) {
      const [method, path] = route.split(' ') as [string, string]
      // A session of their own for each: one route signs it out.
      const cookie = createSession(ctx.db, viewer)
      const response = await request(method, fill(path), { cookie })
      if (V1_FOR_VIEWERS.includes(route)) {
        expect([route, response.status !== 403, response.status < 500]).toEqual(
          [route, true, true],
        )
        continue
      }
      expect([route, response.status, await response.json()]).toEqual([
        route,
        403,
        { error: '没有权限进行此操作' },
      ])
    }
    // Nothing was written but the sessions made here and what the open
    // routes did with them.
    const after = rows(ctx.db)
    const changed = Object.keys(after).filter((t) => after[t] !== before[t])
    expect(changed.toSorted()).toEqual(['web_sessions'])
  })

  test('a viewer’s token: all of /v1 refuses it; the agent API only reads what the table opens', async () => {
    const { ctx, api, app, request, viewerToken, call } = await setup()
    const before = rows(ctx.db)
    for (const permission of ['ro', 'rw'] as const) {
      const token = viewerToken(permission)
      for (const route of routesOf(api.routes).all) {
        const [method, path] = route.split(' ') as [string, string]
        const response = await request(method, fill(path), { token })
        expect([route, response.status, await response.json()]).toEqual([
          route,
          403,
          { error: '这个令牌只能用于 Agent API' },
        ])
      }
      for (const route of routesOf(app.routes, '/agent/v1').all) {
        const [method, path] = route.split(' ') as [string, string]
        const response = await call(fill(path), {
          token,
          method,
          ...(method === 'GET' ? {} : { body: {} }),
        })
        if (AGENT_FOR_VIEWERS.includes(route))
          expect([
            route,
            response.status !== 403,
            response.status < 500,
          ]).toEqual([route, true, true])
        else
          expect([route, response.status, response.json.error]).toEqual([
            route,
            403,
            'forbidden',
          ])
      }
    }
    const after = rows(ctx.db)
    const changed = Object.keys(after).filter((t) => after[t] !== before[t])
    expect(changed).toEqual(['api_tokens'])
  })

  test('a read thread refuses them too: the principal goes with the request', async () => {
    const { ctx, viewer } = await setup()
    const thread = threadApi(ctx, { webAppUrl: WEB })
    const asked = (principal: Principal, path: string) =>
      thread({
        base: '/v1',
        method: 'GET',
        url: `http://localhost/v1${path}`,
        headers: [],
        principal,
      })
    const admin: Principal = {
      userId: adminId(ctx.db),
      role: 'admin',
      via: 'session',
    }
    const them: Principal = { userId: viewer, role: 'viewer', via: 'session' }
    expect((await asked(admin, '/captures')).status).toBe(200)
    expect((await asked(them, '/collections')).status).toBe(200)
    const refused = await asked(them, '/captures')
    expect(refused.status).toBe(403)
    expect(JSON.parse(new TextDecoder().decode(refused.body))).toEqual({
      error: '没有权限进行此操作',
    })
  })
})

describe('users and their own credentials', () => {
  test('GET /session says who is signed in and what the web app may offer', async () => {
    const { ctx, viewer, request } = await setup()
    const admin = adminId(ctx.db)
    const asAdmin = await request('GET', '/session', {
      cookie: createSession(ctx.db, admin),
    })
    expect(await asAdmin.json()).toEqual({
      user: { id: admin, name: '管理员', role: 'admin' },
      can: {
        capture: true,
        organize: true,
        share: true,
        delete: true,
        admin: true,
      },
    })
    const token = createToken(ctx.db, {
      user: admin,
      label: 'x',
      permission: 'ro',
    }).secret
    expect(
      (await (await request('GET', '/session', { token })).json()) as object,
    ).toHaveProperty('can', {
      capture: false,
      organize: false,
      share: false,
      delete: false,
      admin: false,
    })
    const asViewer = await request('GET', '/session', {
      cookie: createSession(ctx.db, viewer),
    })
    expect(await asViewer.json()).toEqual({
      user: { id: viewer, name: '朋友', role: 'viewer' },
      can: {
        capture: false,
        organize: false,
        share: false,
        delete: false,
        admin: false,
      },
    })
  })

  test('each user sees and changes only their own sessions and tokens; another’s id is 404', async () => {
    const { ctx, viewer, request } = await setup()
    const admin = adminId(ctx.db)
    const adminCookie = createSession(ctx.db, admin)
    const viewerCookie = createSession(ctx.db, viewer)
    const otherViewerCookie = createSession(ctx.db, viewer)
    const adminToken = createToken(ctx.db, {
      user: admin,
      label: 'admin’s',
      permission: 'rw',
    }).token
    const made = await request('POST', '/tokens', {
      cookie: viewerCookie,
    })
    expect(made.status).toBe(400)
    const listed = async (cookie: string, path: string) =>
      (
        (await (await request('GET', path, { cookie })).json()) as {
          id: string
          label?: string
        }[]
      ).map((row) => row.label ?? row.id)
    expect(await listed(viewerCookie, '/tokens')).toEqual([])
    expect(await listed(adminCookie, '/tokens')).toEqual(['agent', 'admin’s'])
    expect((await listed(viewerCookie, '/sessions')).length).toBe(2)
    const adminSessions = (await (
      await request('GET', '/sessions', { cookie: adminCookie })
    ).json()) as { id: string }[]
    // Bodies the routes take, so only whose the row is is left to check.
    for (const [method, path, body] of [
      ['PATCH', `/tokens/${adminToken.id}`, { label: 'mine' }],
      ['POST', `/tokens/${adminToken.id}/roll`],
      ['GET', `/tokens/${adminToken.id}/usage`],
      ['DELETE', `/tokens/${adminToken.id}`],
      ['DELETE', `/sessions/${adminSessions[0]!.id}`],
      ['PATCH', `/passkeys/${ID}`, { name: 'x' }],
      ['DELETE', `/passkeys/${ID}`],
    ] as const) {
      const response = await request(
        method,
        path,
        { cookie: viewerCookie },
        body,
      )
      expect([method, path, response.status]).toEqual([method, path, 404])
    }
    // Signing out the others ends only their own.
    const revoked = await request('POST', '/sessions/revoke-others', {
      cookie: viewerCookie,
    })
    expect(await revoked.json()).toEqual({ revoked: 1 })
    expect(
      (await request('GET', '/session', { cookie: otherViewerCookie })).status,
    ).toBe(401)
    expect(
      (await request('GET', '/session', { cookie: adminCookie })).status,
    ).toBe(200)
    expect(await listed(adminCookie, '/tokens')).toEqual(['agent', 'admin’s'])
  })

  test('a viewer makes read-only tokens of their own, for the agent API', async () => {
    const { ctx, viewer, request, call } = await setup()
    const cookie = createSession(ctx.db, viewer)
    const asked = (permission: string) =>
      request(
        'POST',
        '/tokens',
        { cookie },
        { label: 'script', permission, expires_at: null },
      )
    const refused = await asked('rw')
    expect([refused.status, await refused.json()]).toEqual([
      403,
      { error: '查看者只能创建只读令牌' },
    ])
    const made = await asked('ro')
    expect(made.status).toBe(200)
    const { secret } = (await made.json()) as { secret: string }
    expect(secret).toMatch(/^mdn_ro_/)
    expect(await call('/whoami', { token: secret })).toMatchObject({
      status: 200,
      json: { user: { id: viewer, role: 'viewer' } },
    })
    expect(
      (await request('GET', '/collections', { token: secret })).status,
    ).toBe(403)
  })

  test('a revoked user’s session and tokens answer 401', async () => {
    const { ctx, viewer, request, viewerToken, call } = await setup()
    const cookie = createSession(ctx.db, viewer)
    const token = viewerToken()
    expect((await request('GET', '/session', { cookie })).status).toBe(200)
    expect((await call('/whoami', { token })).status).toBe(200)
    ctx.db.$client
      .prepare('UPDATE users SET revoked_at = ? WHERE id = ?')
      .run(Date.now(), viewer)
    expect((await request('GET', '/session', { cookie })).status).toBe(401)
    expect(await call('/whoami', { token })).toMatchObject({
      status: 401,
      json: { error: 'token_invalid' },
    })
  })
})
