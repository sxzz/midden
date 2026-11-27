import { createHmac } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, test } from 'vitest'
import { webSessions } from '#db/schema.ts'
import { testContext } from '#testing/context.ts'
import { tokenSecret } from '#testing/tokens.ts'
import { adminId } from '#users/users.ts'
import { createApi } from './app.ts'
import { addOrigin } from './origins.ts'
import {
  createSession,
  deviceOf,
  pruneSessions,
  SESSION_COOKIE,
  SESSION_RENEW_AFTER,
  SESSION_TTL,
} from './sessions.ts'
import type { AccountsContext } from '#accounts/accounts.ts'
import type { WebReads } from './offload.ts'

const BOT = '1:x'
const WEB = 'https://midden.test'
const OTHER_ORIGIN = 'https://archive.example'
const HOUR = 3_600_000
const DAY = 24 * HOUR
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
const MAC_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15'

let ctx: AccountsContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

function setup(reads?: WebReads) {
  ctx = testContext()
  let time = Date.parse('2026-11-27T00:00:00Z')
  const clock = { now: () => time, advance: (ms: number) => (time += ms) }
  const app = createApi({
    ctx,
    telegram: { token: BOT, owner: '42' },
    webAppUrl: `${WEB}/app/`,
    now: clock.now,
    reads,
  })
  const db = ctx.db
  const request = (cookie: string, path = '/session', init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        Cookie: `${SESSION_COOKIE}=${cookie}`,
        Origin: WEB,
        'Content-Type': 'application/json',
        ...init.headers,
      },
    })
  const row = (id?: string) =>
    id
      ? db.select().from(webSessions).where(eq(webSessions.id, id)).get()
      : db.select().from(webSessions).get()
  const changes = () =>
    db.$client.prepare('SELECT total_changes() AS n').get()!.n as number
  return { app, db, clock, request, row, changes }
}

function initData(user: number, authDate: number) {
  const fields: Record<string, string> = {
    auth_date: String(Math.floor(authDate / 1000)),
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

const maxAgeOf = (response: Response) =>
  /Max-Age=(\d+)/.exec(response.headers.get('set-cookie') ?? '')?.[1]

describe('sliding expiry', () => {
  test('a session lasts 30 days from sign-in, its cookie as long', () => {
    expect(SESSION_TTL).toBe(30 * 24 * 60 * 60)
    expect(SESSION_RENEW_AFTER).toBe(24 * 60 * 60)
  })

  test('renews once a day: 30 more days, a fresh cookie, one write', async () => {
    const { db, clock, request, row, changes } = setup()
    const cookie = createSession(db, adminId(db), undefined, clock.now())
    const signedIn = clock.now()
    expect(row()!.expiresAt.getTime()).toBe(signedIn + 30 * DAY)

    // Within the day: read only, no cookie.
    clock.advance(23 * HOUR)
    const before = changes()
    for (const path of ['/session', '/collections', '/sessions']) {
      const response = await request(cookie, path)
      expect(response.status).toBe(200)
      expect(response.headers.get('set-cookie')).toBeNull()
    }
    expect(changes()).toBe(before)
    expect(row()!.expiresAt.getTime()).toBe(signedIn + 30 * DAY)
    expect(row()!.lastUsedAt.getTime()).toBe(signedIn)

    // A day after: pushed to 30 days from now, the cookie refreshed.
    clock.advance(2 * HOUR)
    const renewed = await request(cookie)
    expect(renewed.status).toBe(200)
    expect(changes()).toBe(before + 1)
    expect(maxAgeOf(renewed)).toBe(String(SESSION_TTL))
    expect(renewed.headers.get('set-cookie')).toContain(
      `${SESSION_COOKIE}=${cookie};`,
    )
    expect(renewed.headers.get('set-cookie')).toContain('HttpOnly')
    expect(renewed.headers.get('set-cookie')).toContain('SameSite=None')
    expect(row()!.expiresAt.getTime()).toBe(clock.now() + 30 * DAY)
    expect(row()!.lastUsedAt.getTime()).toBe(clock.now())
    // And then not again that day.
    clock.advance(HOUR)
    expect((await request(cookie)).headers.get('set-cookie')).toBeNull()
    expect(changes()).toBe(before + 1)
  })

  test('a read answered on a read thread renews too', async () => {
    const { db, clock, request } = setup({
      run: async () => ({
        status: 200,
        headers: [['content-type', 'application/json']],
        body: new TextEncoder().encode('{"thread":true}').buffer as ArrayBuffer,
      }),
      read: () => Promise.reject(new Error('no reads by name here')),
    })
    const cookie = createSession(db, adminId(db), undefined, clock.now())
    clock.advance(2 * DAY)
    const response = await request(cookie, '/collections')
    expect(await response.json()).toEqual({ thread: true })
    expect(maxAgeOf(response)).toBe(String(SESSION_TTL))
  })

  test('used within 30 days it stays; after 30 idle days it is gone', async () => {
    const { db, clock, request } = setup()
    const cookie = createSession(db, adminId(db), undefined, clock.now())
    // Used every 20 days for 100 days.
    for (let i = 0; i < 5; i++) {
      clock.advance(20 * DAY)
      expect((await request(cookie)).status).toBe(200)
    }
    clock.advance(30 * DAY + 1)
    const expired = await request(cookie)
    expect(expired.status).toBe(401)
    expect(expired.headers.get('set-cookie')).toBeNull()
    expect((await request(cookie, '/collections')).status).toBe(401)
    pruneSessions(db, clock.now())
    expect(db.select().from(webSessions).all()).toEqual([])
  })

  test('signing out does not hand the cookie back, even when due', async () => {
    const { db, clock, request } = setup()
    const cookie = createSession(db, adminId(db), undefined, clock.now())
    clock.advance(2 * DAY)
    const out = await request(cookie, '/session', { method: 'DELETE' })
    expect(out.status).toBe(204)
    expect(out.headers.getSetCookie()).toEqual([
      expect.stringMatching(new RegExp(`^${SESSION_COOKIE}=;.*Max-Age=0`)),
    ])
    expect(db.select().from(webSessions).all()).toEqual([])
  })
})

describe('session management', () => {
  function three() {
    const s = setup()
    const login = (userAgent: string) =>
      createSession(
        s.db,
        adminId(s.db),
        { method: 'passkey', origin: WEB, userAgent },
        s.clock.now(),
      )
    const here = login(MAC_SAFARI)
    s.clock.advance(HOUR)
    const phone = login(IPHONE)
    s.clock.advance(HOUR)
    const old = createSession(s.db, adminId(s.db), undefined, s.clock.now())
    return { ...s, here, phone, old }
  }
  type Listed = {
    id: string
    current: boolean
    method: string | null
    origin: string | null
    device: string | null
    created_at: string
    last_used_at: string
    expires_at: string
  }
  const list = async (
    request: ReturnType<typeof setup>['request'],
    cookie: string,
  ) => (await (await request(cookie, '/sessions')).json()) as Listed[]

  test('lists the sessions, this one first, without their digests', async () => {
    const { request, here, clock } = three()
    const listed = await list(request, here)
    expect(listed).toHaveLength(3)
    expect(listed[0]).toEqual({
      id: expect.any(String),
      current: true,
      method: 'passkey',
      origin: WEB,
      device: 'Safari · macOS',
      created_at: new Date(clock.now() - 2 * HOUR).toISOString(),
      last_used_at: new Date(clock.now() - 2 * HOUR).toISOString(),
      expires_at: new Date(clock.now() - 2 * HOUR + 30 * DAY).toISOString(),
    })
    // The rest by when they were last used.
    expect(listed.slice(1).map((s) => [s.current, s.device])).toEqual([
      [false, null],
      [false, 'iOS'],
    ])
  })

  test('revokes one, or all the others; this one stays', async () => {
    const { request, here, phone, old } = three()
    const listed = await list(request, here)
    const phoneId = (await list(request, phone)).find((s) => s.current)!.id
    const revoke = (id: string) =>
      request(here, `/sessions/${id}`, { method: 'DELETE' })
    expect((await revoke(phoneId)).status).toBe(204)
    expect((await request(phone)).status).toBe(401)
    expect((await revoke(phoneId)).status).toBe(404)
    expect(await list(request, here)).toHaveLength(2)

    const others = await request(here, '/sessions/revoke-others', {
      method: 'POST',
    })
    expect(await others.json()).toEqual({ revoked: 1 })
    expect((await request(old)).status).toBe(401)
    expect(await list(request, here)).toEqual([
      expect.objectContaining({ id: listed[0]!.id, current: true }),
    ])

    // Revoking this one signs this browser out.
    const out = await revoke(listed[0]!.id)
    expect(out.status).toBe(204)
    expect(out.headers.get('set-cookie')).toMatch(/Max-Age=0/)
    expect((await request(here)).status).toBe(401)
  })

  test('API tokens neither list nor revoke sessions', async () => {
    const { app, db, here, request } = three()
    for (const permission of ['ro', 'rw'] as const) {
      const token = tokenSecret(db, permission)
      const as = (path: string, method = 'GET') =>
        app.request(path, {
          method,
          headers: { Authorization: `Bearer ${token}`, Origin: WEB },
        })
      expect((await as('/sessions')).status).toBe(403)
      expect((await as('/sessions/revoke-others', 'POST')).status).toBe(403)
      const id = db.select().from(webSessions).get()!.id
      expect((await as(`/sessions/${id}`, 'DELETE')).status).toBe(403)
    }
    expect(db.select().from(webSessions).all()).toHaveLength(3)
    expect((await request(here)).status).toBe(200)
  })
})

describe('the Mini App', () => {
  test('signs in as Telegram, and signing in again does not add rows', async () => {
    const { app, db, clock, request } = setup()
    const login = (userAgent: string, cookie?: string, origin = WEB) =>
      app.request('/auth/telegram', {
        method: 'POST',
        headers: {
          Origin: origin,
          'User-Agent': userAgent,
          'Content-Type': 'application/json',
          ...(cookie ? { Cookie: `${SESSION_COOKIE}=${cookie}` } : {}),
        },
        body: JSON.stringify({ init_data: initData(42, clock.now()) }),
      })
    const cookieOf = (response: Response) =>
      /^__Host-midden=([^;]+)/.exec(response.headers.get('set-cookie')!)![1]!
    const first = await login(IPHONE)
    expect(maxAgeOf(first)).toBe(String(SESSION_TTL))
    const cookie = cookieOf(first)
    expect(db.select().from(webSessions).all()).toEqual([
      expect.objectContaining({
        method: 'telegram',
        origin: WEB,
        device: 'Telegram · iOS',
      }),
    ])
    // Launched again, with the cookie or without it (the web view lost it).
    const again = cookieOf(await login(IPHONE, cookie))
    expect((await request(cookie)).status).toBe(401)
    expect((await request(again)).status).toBe(200)
    const third = cookieOf(await login(IPHONE))
    expect((await request(again)).status).toBe(401)
    expect(db.select().from(webSessions).all()).toHaveLength(1)

    // Another kind of device, or another domain, keeps its own.
    await login(MAC_SAFARI)
    addOrigin(db, `${WEB}/app/`, OTHER_ORIGIN)
    await login(IPHONE, undefined, OTHER_ORIGIN)
    // And a passkey session on the same domain stays.
    createSession(db, adminId(db), {
      method: 'passkey',
      origin: WEB,
      userAgent: IPHONE,
    })
    await login(IPHONE)
    expect(
      db
        .select({ method: webSessions.method, device: webSessions.device })
        .from(webSessions)
        .all()
        .map((s) => `${s.method} ${s.device}`)
        .toSorted(),
    ).toEqual([
      'passkey iOS',
      'telegram Telegram · iOS',
      'telegram Telegram · iOS',
      'telegram Telegram · macOS',
    ])
    expect((await request(third)).status).toBe(401)
  })
})

describe('deviceOf', () => {
  test.each([
    [MAC_SAFARI, 'Safari · macOS'],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
      'Safari · iOS',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Chrome · Windows',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
      'Edge · Windows',
    ],
    [
      'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
      'Firefox · Linux',
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
      'Chrome · Android',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1',
      'Chrome · iOS',
    ],
    ['curl/8.0', null],
    [undefined, null],
  ])('%s', (ua, device) => {
    expect(deviceOf(ua)).toBe(device)
  })

  test('the Mini App is Telegram, on whatever system', () => {
    expect(deviceOf(IPHONE, 'telegram')).toBe('Telegram · iOS')
    expect(deviceOf(undefined, 'telegram')).toBe('Telegram')
  })
})
