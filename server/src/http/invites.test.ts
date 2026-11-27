// Invites and users (docs/design/multi-user.md §4, §8.4, §8.5): the admin
// invites a friend, who registers a passkey and becomes a viewer with a
// nickname of their own; the admin notes, revokes and deletes them.
import { Buffer } from 'node:buffer'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, test } from 'vitest'
import { deriveKey, unseal } from '#crypto.ts'
import { apiTokens, invites, passkeys, users, webSessions } from '#db/schema.ts'
import { handle } from '#telegram/commands.ts'
import { softAuthenticator } from '#testing/authenticator.ts'
import { testContext } from '#testing/context.ts'
import { createToken } from '#tokens/tokens.ts'
import { INVITE_TTL, pruneInvites } from '#users/invites.ts'
import { adminId } from '#users/users.ts'
import { createApi, SESSION_COOKIE } from './app.ts'
import { addOrigin } from './origins.ts'
import { createSession } from './sessions.ts'
import { inviteLink } from './user-routes.ts'
import type { AccountsContext } from '#accounts/accounts.ts'
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server'

const MAIN = 'https://midden.test'
const OTHER = 'https://archive.example'
const HOUR = 3_600_000

let ctx: AccountsContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

type Authenticator = ReturnType<typeof softAuthenticator>

function setup() {
  ctx = testContext()
  let time = Date.now()
  const clock = { now: () => time, advance: (ms: number) => (time += ms) }
  addOrigin(ctx.db, `${MAIN}/`, OTHER)
  const notices: string[] = []
  const inviteKey = deriveKey('test-secret', 'invite-links')
  const app = createApi({
    ctx,
    telegram: { token: '1:x', owner: '42' },
    webAppUrl: `${MAIN}/`,
    inviteKey,
    notify: (text) => notices.push(text),
    now: clock.now,
  })
  const admin = adminId(ctx.db)
  const adminCookie = createSession(ctx.db, admin)
  const call = (
    method: string,
    path: string,
    body?: unknown,
    init: { cookie?: string; origin?: string; token?: string } = {},
  ) =>
    app.request(path, {
      method,
      headers: {
        Origin: init.origin ?? MAIN,
        'Content-Type': 'application/json',
        ...(init.cookie ? { Cookie: `${SESSION_COOKIE}=${init.cookie}` } : {}),
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  /** As the admin, signed in. */
  const asAdmin = (method: string, path: string, body?: unknown) =>
    call(method, path, body, { cookie: adminCookie })
  /** A new invite's id and the token from its link. */
  async function invite(label = '小明') {
    const made = await asAdmin('POST', '/invites', { label })
    expect(made.status).toBe(200)
    const { invite, url } = (await made.json()) as {
      invite: { id: string }
      url: string
    }
    expect(url).toMatch(new RegExp(String.raw`^${MAIN}/invite#[\w-]{43}$`))
    return { id: invite.id, token: url.split('#', 2)[1]! }
  }
  async function options(token: string, origin = MAIN, name = '小明') {
    return call('POST', '/auth/invite/options', { token, name }, { origin })
  }
  /** Register with an invite: its options, then the passkey. */
  async function accept(
    token: string,
    authenticator: Authenticator = softAuthenticator(),
    origin = MAIN,
    name = '小明',
  ) {
    const asked = await options(token, origin, name)
    if (!asked.ok) return { response: asked, authenticator }
    const creation =
      (await asked.json()) as PublicKeyCredentialCreationOptionsJSON
    const response = await call(
      'POST',
      '/auth/invite',
      {
        token,
        name,
        passkey_name: 'iPhone',
        response: authenticator.create(creation, origin),
      },
      { origin },
    )
    return { response, authenticator, creation }
  }
  async function signIn(authenticator: Authenticator, origin = MAIN) {
    const request = (await (
      await call('POST', '/auth/passkey/options', {}, { origin })
    ).json()) as PublicKeyCredentialRequestOptionsJSON
    return call(
      'POST',
      '/auth/passkey',
      { response: authenticator.get(request, origin) },
      { origin },
    )
  }
  const cookieOf = (response: Response) =>
    response.headers.get('set-cookie')?.split(';', 1)[0]?.split('=', 2)[1]
  /** The pending invites as the admin's 用户 page lists them. */
  const listed = async () =>
    (await (await asAdmin('GET', '/invites')).json()) as {
      id: string
      label: string
      expires_at: string
      url: string | null
    }[]
  return {
    ctx,
    app,
    clock,
    notices,
    inviteKey,
    listed,
    admin,
    adminCookie,
    call,
    asAdmin,
    invite,
    options,
    accept,
    signIn,
    cookieOf,
  }
}

describe('invites', () => {
  test('register a viewer, signed in, with a handle of their own; the invite is used up and listed no more', async () => {
    const s = setup()
    const { id, token } = await s.invite('同事')
    expect(await s.listed()).toEqual([
      {
        id,
        label: '同事',
        created_at: expect.any(String),
        expires_at: new Date(s.clock.now() + INVITE_TTL).toISOString(),
        url: `${MAIN}/invite#${token}`,
      },
    ])
    const { response, creation, authenticator } = await s.accept(token)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { user: { id: string } }
    // Their own nickname; the label is the admin's note, never theirs.
    expect(body).toEqual({
      user: { id: expect.any(String), name: '小明', role: 'viewer' },
    })
    // The options: the new user's own handle, their name, nothing excluded.
    const row = s.ctx.db
      .select()
      .from(users)
      .where(eq(users.id, body.user.id))
      .get()!
    expect(creation!.user).toMatchObject({ id: row.webauthnId, name: '小明' })
    expect(row).toMatchObject({ name: '小明', note: '同事' })
    expect(row.webauthnId).not.toBe('bWlkZGVuLW93bmVy')
    expect(Buffer.from(row.webauthnId, 'base64url')).toHaveLength(32)
    expect(creation!.excludeCredentials).toEqual([])
    expect(authenticator.handle).toBe(row.webauthnId)
    // Signed in as them.
    const cookie = s.cookieOf(response)!
    expect(
      await (await s.call('GET', '/session', undefined, { cookie })).json(),
    ).toMatchObject({ user: { id: body.user.id, role: 'viewer' } })
    expect(
      s.ctx.db
        .select()
        .from(webSessions)
        .where(eq(webSessions.userId, body.user.id))
        .get(),
    ).toMatchObject({ method: 'passkey', origin: MAIN })
    // Used up, by them, its token no longer kept.
    expect(s.ctx.db.select().from(invites).get()).toMatchObject({
      usedBy: body.user.id,
      usedAt: new Date(s.clock.now()),
      sealedToken: null,
    })
    expect(await (await s.asAdmin('GET', '/invites')).json()).toEqual([])
    // They sign in again with it.
    const again = await s.signIn(authenticator)
    expect(again.status).toBe(204)
    expect(
      await (
        await s.call('GET', '/session', undefined, {
          cookie: s.cookieOf(again)!,
        })
      ).json(),
    ).toMatchObject({ user: { id: body.user.id } })
    // Nothing went to the bot.
    expect(s.notices).toEqual([])
  })

  test('once only: a second registration, also at the same time, is refused', async () => {
    const s = setup()
    const { token } = await s.invite()
    expect((await s.accept(token)).response.status).toBe(200)
    const second = await s.accept(token)
    expect(second.response.status).toBe(403)
    expect(await second.response.json()).toEqual({ error: '邀请链接已失效' })

    const other = await s.invite('小红')
    const asked = await Promise.all(
      [0, 1].map(async () => {
        const authenticator = softAuthenticator()
        const creation = (await (
          await s.options(other.token)
        ).json()) as PublicKeyCredentialCreationOptionsJSON
        return { authenticator, creation }
      }),
    )
    const answers = await Promise.all(
      asked.map(({ authenticator, creation }) =>
        s.call('POST', '/auth/invite', {
          token: other.token,
          name: '小红',
          passkey_name: 'x',
          response: authenticator.create(creation, MAIN),
        }),
      ),
    )
    expect(answers.map((r) => r.status).toSorted()).toEqual([200, 403])
    expect(
      s.ctx.db.select().from(users).where(eq(users.name, '小红')).all(),
    ).toHaveLength(1)
  })

  test('expired, revoked or on another domain, an invite is the same 403', async () => {
    const s = setup()
    const expired = await s.invite('a')
    const revoked = await s.invite('b')
    const elsewhere = await s.invite('c')
    expect((await s.asAdmin('DELETE', `/invites/${revoked.id}`)).status).toBe(
      204,
    )
    expect((await s.asAdmin('DELETE', `/invites/${revoked.id}`)).status).toBe(
      404,
    )
    // Options asked in time, registered too late.
    const late = await s.options(expired.token)
    expect(late.status).toBe(200)
    s.clock.advance(INVITE_TTL - HOUR)
    expect((await s.options(elsewhere.token)).status).toBe(200)
    s.clock.advance(HOUR + 1)
    for (const [token, origin] of [
      [expired.token, MAIN],
      [revoked.token, MAIN],
      [elsewhere.token, OTHER],
      ['x'.repeat(43), MAIN],
    ] as const) {
      const options = await s.options(token, origin)
      expect([options.status, await options.json()]).toEqual([
        403,
        { error: '邀请链接已失效' },
      ])
    }
    // Registering is refused the same way.
    const creation =
      (await late.json()) as PublicKeyCredentialCreationOptionsJSON
    const register = await s.call('POST', '/auth/invite', {
      token: expired.token,
      name: 'a',
      passkey_name: 'x',
      response: softAuthenticator().create(creation, MAIN),
    })
    expect([register.status, await register.json()]).toEqual([
      403,
      { error: '邀请链接已失效' },
    ])
    expect(
      s.ctx.db.select().from(users).where(eq(users.role, 'viewer')).all(),
    ).toEqual([])
  })

  test('a challenge answers for its own invite only, never another or a /passkey link', async () => {
    const s = setup()
    const a = await s.invite('a')
    const b = await s.invite('b')
    const forA = (await (
      await s.options(a.token)
    ).json()) as PublicKeyCredentialCreationOptionsJSON
    // A's challenge, sent with B's token.
    const crossed = await s.call('POST', '/auth/invite', {
      token: b.token,
      name: 'b',
      passkey_name: 'x',
      response: softAuthenticator().create(forA, MAIN),
    })
    expect(crossed.status).toBe(400)
    // Nor with a /passkey link.
    const reply = handle(
      {
        ctx: s.ctx,
        webAppUrl: `${MAIN}/`,
        version: 'dev',
        now: s.clock.now,
      },
      {
        command: 'passkey',
        arg: '',
        group: false,
        chatId: '42',
        messageId: 1,
        updateId: 1,
        links: [],
      },
    )
    const link = (reply.keyboard ?? [])
      .flat()
      .map((b) => ('url' in b ? b.url! : ''))
      .find((url) => url.startsWith(MAIN))!
      .split('#', 2)[1]!
    const viaLink = await s.call('POST', '/auth/passkey/register', {
      token: link,
      name: 'x',
      response: softAuthenticator().create(forA, MAIN),
    })
    expect(viaLink.status).toBe(400)
    // And a link's challenge does not register with an invite.
    const forLink = (await (
      await s.call('POST', '/auth/passkey/register/options', { token: link })
    ).json()) as PublicKeyCredentialCreationOptionsJSON
    const viaInvite = await s.call('POST', '/auth/invite', {
      token: a.token,
      name: 'a',
      passkey_name: 'x',
      response: softAuthenticator().create(forLink, MAIN),
    })
    expect(viaInvite.status).toBe(400)
    // A's own still works, and the link still adds the admin's.
    expect((await s.accept(a.token)).response.status).toBe(200)
    const owner = softAuthenticator()
    const added = await s.call('POST', '/auth/passkey/register', {
      token: link,
      name: 'Mac',
      response: owner.create(forLink, MAIN),
    })
    expect(added.status).toBe(200)
    expect(forLink.user.id).toBe('bWlkZGVuLW93bmVy')
    expect(
      s.ctx.db
        .select({ user: passkeys.userId, name: passkeys.name })
        .from(passkeys)
        .all()
        .toSorted((x, y) => x.name.localeCompare(y.name)),
    ).toEqual([
      { user: expect.not.stringMatching(s.admin), name: 'iPhone' },
      { user: s.admin, name: 'Mac' },
    ])
    // The bot told the admin of their own passkey only.
    expect(s.notices).toEqual(['已添加通行密钥：Mac（midden.test）'])
  })

  test('the admin’s and a viewer’s passkeys on one keychain: each its own handle, excluding only their own', async () => {
    const s = setup()
    // The admin has a passkey here, from a link.
    const reply = handle(
      {
        ctx: s.ctx,
        webAppUrl: `${MAIN}/`,
        version: 'dev',
        now: s.clock.now,
      },
      {
        command: 'passkey',
        arg: '',
        group: false,
        chatId: '42',
        messageId: 1,
        updateId: 1,
        links: [],
      },
    )
    const link = (reply.keyboard ?? [])
      .flat()
      .map((b) => ('url' in b ? b.url! : ''))
      .find((url) => url.startsWith(MAIN))!
      .split('#', 2)[1]!
    const forLink = (await (
      await s.call('POST', '/auth/passkey/register/options', { token: link })
    ).json()) as PublicKeyCredentialCreationOptionsJSON
    const owner = softAuthenticator()
    await s.call('POST', '/auth/passkey/register', {
      token: link,
      name: 'Mac',
      response: owner.create(forLink, MAIN),
    })
    const { token } = await s.invite()
    const joined = await s.accept(token)
    const cookie = s.cookieOf(joined.response)!
    // Adding another, signed in: their handle, their passkey excluded, not the admin's.
    const more = (await (
      await s.call('POST', '/passkeys/options', {}, { cookie })
    ).json()) as PublicKeyCredentialCreationOptionsJSON
    expect(more.user.id).toBe(joined.authenticator.handle)
    expect(more.excludeCredentials?.map((c) => c.id)).toEqual([
      joined.authenticator.id,
    ])
    const ownerMore = (await (
      await s.asAdmin('POST', '/passkeys/options', {})
    ).json()) as PublicKeyCredentialCreationOptionsJSON
    expect(ownerMore.user.id).toBe('bWlkZGVuLW93bmVy')
    expect(ownerMore.excludeCredentials?.map((c) => c.id)).toEqual([owner.id])
    // Each signs in as themselves.
    for (const [authenticator, role] of [
      [owner, 'admin'],
      [joined.authenticator, 'viewer'],
    ] as const) {
      const signedIn = await s.signIn(authenticator)
      expect(
        await (
          await s.call('GET', '/session', undefined, {
            cookie: s.cookieOf(signedIn)!,
          })
        ).json(),
      ).toMatchObject({ user: { role } })
    }
    // A viewer's own passkey comes and goes without a word to the bot.
    const second = softAuthenticator()
    const added = await s.call(
      'POST',
      '/passkeys',
      { name: 'iPad', response: second.create(more, MAIN) },
      { cookie },
    )
    expect(added.status).toBe(200)
    const { id } = (await added.json()) as { id: string }
    expect(
      (await s.call('DELETE', `/passkeys/${id}`, undefined, { cookie })).status,
    ).toBe(204)
    expect(s.notices).toEqual(['已添加通行密钥：Mac（midden.test）'])
  })

  test('a pending invite’s link shows again, its token sealed at rest: no row holds it in plain text', async () => {
    const s = setup()
    const a = await s.invite('a')
    const b = await s.invite('b')
    const urls = (await s.listed()).map((i) => i.url)
    expect(urls).toEqual([
      `${MAIN}/invite#${a.token}`,
      `${MAIN}/invite#${b.token}`,
    ])
    expect((await s.listed()).map((i) => i.url)).toEqual(urls)
    // Whatever the encoding, the database has the digest, not the token.
    const raw = s.ctx.db.$client.prepare('SELECT * FROM invites').all()
    const dump = JSON.stringify(raw, (_key, value: unknown) =>
      value instanceof Uint8Array
        ? Buffer.from(value).toString('latin1')
        : value,
    )
    for (const { token } of [a, b])
      for (const encoded of [
        token,
        Buffer.from(token, 'base64url').toString('hex'),
        Buffer.from(token, 'base64url').toString('base64'),
        Buffer.from(token, 'base64url').toString('latin1'),
      ])
        expect(dump).not.toContain(encoded)
    // It opens with the key derived for invites, bound to its own row.
    const row = s.ctx.db
      .select()
      .from(invites)
      .where(eq(invites.id, a.id))
      .get()!
    expect(
      unseal(s.inviteKey, `invite:${a.id}`, row.sealedToken!).toString(),
    ).toBe(a.token)
    expect(() =>
      unseal(s.inviteKey, `invite:${b.id}`, row.sealedToken!),
    ).toThrow()
    // Copied to another row it opens nowhere: that invite shows no link.
    s.ctx.db
      .update(invites)
      .set({ sealedToken: row.sealedToken })
      .where(eq(invites.id, b.id))
      .run()
    expect((await s.listed()).map((i) => i.url)).toEqual([urls[0], null])
    // With another key (SECRET_KEY changed) none shows, and the links still work.
    const other = createApi({
      ctx: s.ctx,
      webAppUrl: `${MAIN}/`,
      inviteKey: deriveKey('another-secret', 'invite-links'),
      now: s.clock.now,
    })
    const elsewhere = await other.request('/invites', {
      headers: { Cookie: `${SESSION_COOKIE}=${s.adminCookie}` },
    })
    expect(
      ((await elsewhere.json()) as { url: unknown }[]).map((i) => i.url),
    ).toEqual([null, null])
    expect((await s.accept(a.token)).response.status).toBe(200)
  })

  test('making a link again: the same invite and label, 7 days from now, and the old link stops at once', async () => {
    const s = setup()
    const { id, token: old } = await s.invite('小红')
    s.clock.advance(3 * 24 * HOUR)
    // Options asked with the old link, before it is replaced.
    const before = (await (
      await s.options(old)
    ).json()) as PublicKeyCredentialCreationOptionsJSON
    const made = await s.asAdmin('POST', `/invites/${id}/regenerate`)
    expect(made.status).toBe(200)
    const { invite, url } = (await made.json()) as {
      invite: { id: string; label: string; expires_at: string }
      url: string
    }
    const token = url.split('#', 2)[1]!
    expect(token).not.toBe(old)
    expect(invite).toMatchObject({
      id,
      label: '小红',
      expires_at: new Date(s.clock.now() + INVITE_TTL).toISOString(),
    })
    expect((await s.listed()).map((i) => [i.id, i.url])).toEqual([[id, url]])
    // The old link: refused, also with the options it already had.
    expect(
      (await s.call('POST', '/auth/invite/check', { token: old })).status,
    ).toBe(403)
    expect((await s.options(old)).status).toBe(403)
    const authenticator = softAuthenticator()
    const register = (t: string) =>
      s.call('POST', '/auth/invite', {
        token: t,
        name: '小红',
        passkey_name: 'x',
        response: authenticator.create(before, MAIN),
      })
    expect((await register(old)).status).toBe(403)
    // Nor does the old link's challenge answer for the new one.
    expect((await register(token)).status).toBe(400)
    // Good past the first 7 days, from when it was made again.
    s.clock.advance(INVITE_TTL - HOUR)
    expect((await s.accept(token)).response.status).toBe(200)
    // Used up, it is made again no more; nor one revoked, expired or unknown.
    const revoked = await s.invite('r')
    await s.asAdmin('DELETE', `/invites/${revoked.id}`)
    const expired = await s.invite('e')
    s.clock.advance(INVITE_TTL + 1)
    for (const gone of [id, revoked.id, expired.id, 'nope'])
      expect(
        await (await s.asAdmin('POST', `/invites/${gone}/regenerate`)).json(),
      ).toEqual({ error: '邀请不存在或已失效' })
    expect(await s.listed()).toEqual([])
  })

  test('an invite whose token was not kept shows no link until made again; revoked or used, none is kept', async () => {
    const s = setup()
    const { id, token } = await s.invite('旧')
    // As the migration leaves invites made before tokens were kept.
    s.ctx.db
      .update(invites)
      .set({ sealedToken: null })
      .where(eq(invites.id, id))
      .run()
    expect((await s.listed()).map((i) => i.url)).toEqual([null])
    expect((await s.options(token)).status).toBe(200)
    const made = (await (
      await s.asAdmin('POST', `/invites/${id}/regenerate`)
    ).json()) as { url: string }
    expect((await s.listed()).map((i) => i.url)).toEqual([made.url])
    await s.asAdmin('DELETE', `/invites/${id}`)
    expect(
      s.ctx.db.select().from(invites).where(eq(invites.id, id)).get(),
    ).toMatchObject({ sealedToken: null, revokedAt: expect.any(Date) })
  })

  test('the invite page checks its link and learns nothing of the label', async () => {
    const s = setup()
    const { token } = await s.invite('只给管理员看的备注')
    const check = await s.call('POST', '/auth/invite/check', { token })
    expect([check.status, await check.text()]).toEqual([204, ''])
    // Options need the nickname they chose: the label never stands in.
    expect(
      (await s.call('POST', '/auth/invite/options', { token })).status,
    ).toBe(400)
    const asked = await s.options(token, MAIN, '小明')
    expect(await asked.text()).not.toContain('只给管理员看的备注')
    for (const [t, origin] of [
      [token, OTHER],
      ['x'.repeat(43), MAIN],
    ] as const) {
      const refused = await s.call(
        'POST',
        '/auth/invite/check',
        { token: t },
        { origin },
      )
      expect([refused.status, await refused.json()]).toEqual([
        403,
        { error: '邀请链接已失效' },
      ])
    }
  })

  test('the link is the web app’s invite page under WEB_APP_URL, wherever that is', () => {
    expect(inviteLink('https://midden.test', 'T')).toBe(
      'https://midden.test/invite#T',
    )
    expect(inviteLink('https://midden.test/?v=3', 'T')).toBe(
      'https://midden.test/invite#T',
    )
    expect(inviteLink('https://midden.test/', 'T')).toBe(
      'https://midden.test/invite#T',
    )
  })

  test('done with a week ago, an invite is pruned', async () => {
    const s = setup()
    const now = s.clock.now()
    const used = await s.invite('used')
    await s.accept(used.token)
    const pending = await s.invite('pending')
    const revoked = await s.invite('revoked')
    await s.asAdmin('DELETE', `/invites/${revoked.id}`)
    pruneInvites(s.ctx.db, now + 7 * 24 * HOUR - 1)
    expect(s.ctx.db.select().from(invites).all()).toHaveLength(3)
    // A week after the last was done with; the pending one expired by then.
    pruneInvites(s.ctx.db, now + 14 * 24 * HOUR + 1)
    expect(s.ctx.db.select().from(invites).all()).toEqual([])
    expect(pending.id).toBeTruthy()
  })
})

describe('users', () => {
  async function withViewer() {
    const s = setup()
    const { token } = await s.invite('同事小明')
    const joined = await s.accept(token)
    const cookie = s.cookieOf(joined.response)!
    const { user } = (await joined.response.json()) as {
      user: { id: string }
    }
    const viewerToken = createToken(s.ctx.db, {
      user: user.id,
      label: 'script',
      permission: 'ro',
    }).secret
    return { ...s, viewer: user.id, cookie, viewerToken, joined }
  }

  test('the list: the admin first, then viewers with how many ways in each has', async () => {
    const s = await withViewer()
    createSession(s.ctx.db, s.viewer)
    expect(await (await s.asAdmin('GET', '/users')).json()).toEqual([
      {
        id: s.admin,
        name: '管理员',
        note: null,
        role: 'admin',
        created_at: expect.any(String),
        revoked_at: null,
        passkeys: 0,
        sessions: 1,
        tokens: 0,
      },
      {
        id: s.viewer,
        name: '小明',
        note: '同事小明',
        role: 'viewer',
        created_at: new Date(s.clock.now()).toISOString(),
        revoked_at: null,
        passkeys: 1,
        sessions: 2,
        tokens: 1,
      },
    ])
    // The admin's note changes, their nickname does not; empty clears it.
    const noted = await s.asAdmin('PATCH', `/users/${s.viewer}`, {
      note: ' 大学同学 ',
    })
    expect(await noted.json()).toMatchObject({ name: '小明', note: '大学同学' })
    expect(
      await (
        await s.asAdmin('PATCH', `/users/${s.viewer}`, { note: ' ' })
      ).json(),
    ).toMatchObject({ name: '小明', note: null })
    for (const body of [
      { note: 'x'.repeat(33) },
      // The nickname is theirs, and there is no role to change.
      { name: 'x' },
      { note: 'x', role: 'admin' },
    ])
      expect(
        (await s.asAdmin('PATCH', `/users/${s.viewer}`, body)).status,
      ).toBe(400)
  })

  test('each sets their own nickname with their session; no token, nobody else’s', async () => {
    const s = await withViewer()
    const asViewer = (method: string, path: string, body?: unknown) =>
      s.call(method, path, body, { cookie: s.cookie })
    const set = await asViewer('PATCH', '/session', { name: ' 明 ' })
    expect(await set.json()).toEqual({
      user: { id: s.viewer, name: '明', role: 'viewer' },
      can: {
        capture: false,
        organize: false,
        share: false,
        delete: false,
        admin: false,
      },
    })
    expect(await (await asViewer('GET', '/session')).json()).toMatchObject({
      user: { name: '明' },
    })
    // The admin sees it, their note untouched.
    expect(
      ((await (await s.asAdmin('GET', '/users')).json()) as object[])[1],
    ).toMatchObject({ name: '明', note: '同事小明' })
    // The admin has one too, and no note.
    expect(
      await (await s.asAdmin('PATCH', '/session', { name: '阿管' })).json(),
    ).toMatchObject({ user: { id: s.admin, name: '阿管', role: 'admin' } })
    for (const body of [{ name: ' ' }, { name: 'x'.repeat(33) }, { note: 'x' }])
      expect((await asViewer('PATCH', '/session', body)).status).toBe(400)
    // A token, the admin's read and write one included, is never a session.
    const rw = createToken(s.ctx.db, {
      user: s.admin,
      label: 'rw',
      permission: 'rw',
    }).secret
    for (const token of [rw, s.viewerToken])
      expect(
        (await s.call('PATCH', '/session', { name: 'x' }, { token })).status,
      ).toBe(403)
    // A viewer reaches no one's note, their own included.
    for (const [method, path, body] of [
      ['GET', '/users'],
      ['PATCH', `/users/${s.viewer}`, { note: 'x' }],
      ['PATCH', `/users/${s.admin}`, { note: 'x' }],
    ] as const)
      expect((await asViewer(method, path, body)).status).toBe(403)
    expect(
      s.ctx.db.select({ name: users.name, note: users.note }).from(users).all(),
    ).toEqual(
      expect.arrayContaining([
        { name: '阿管', note: null },
        { name: '明', note: '同事小明' },
      ]),
    )
  })

  test('revoking signs them out at once and leaves the row, revoked', async () => {
    const s = await withViewer()
    const revoked = await s.asAdmin('POST', `/users/${s.viewer}/revoke`)
    expect(await revoked.json()).toMatchObject({
      id: s.viewer,
      revoked_at: new Date(s.clock.now()).toISOString(),
      passkeys: 0,
      sessions: 0,
      tokens: 0,
    })
    expect(
      (await s.call('GET', '/session', undefined, { cookie: s.cookie })).status,
    ).toBe(401)
    expect(
      (await s.call('GET', '/session', undefined, { token: s.viewerToken }))
        .status,
    ).toBe(401)
    expect((await s.signIn(s.joined.authenticator)).status).toBe(400)
    for (const table of [passkeys, webSessions, apiTokens])
      expect(
        s.ctx.db
          .select()
          .from(table)
          .all()
          .filter((row) => row.userId === s.viewer),
      ).toEqual([])
    expect(
      s.ctx.db.select().from(users).where(eq(users.id, s.viewer)).get(),
    ).toMatchObject({ revokedAt: new Date(s.clock.now()) })
    // Deleting a revoked one works too.
    expect((await s.asAdmin('DELETE', `/users/${s.viewer}`)).status).toBe(204)
  })

  test('deleting takes the user and their ways in; their invite forgets them', async () => {
    const s = await withViewer()
    expect((await s.asAdmin('DELETE', `/users/${s.viewer}`)).status).toBe(204)
    expect(
      (await s.call('GET', '/session', undefined, { cookie: s.cookie })).status,
    ).toBe(401)
    expect(
      (await s.call('GET', '/session', undefined, { token: s.viewerToken }))
        .status,
    ).toBe(401)
    expect((await s.signIn(s.joined.authenticator)).status).toBe(400)
    expect(
      s.ctx.db.select().from(users).where(eq(users.id, s.viewer)).get(),
    ).toBeUndefined()
    for (const table of [passkeys, webSessions, apiTokens])
      expect(
        s.ctx.db
          .select()
          .from(table)
          .all()
          .filter((row) => row.userId === s.viewer),
      ).toEqual([])
    expect(s.ctx.db.select().from(invites).get()).toMatchObject({
      usedBy: null,
    })
    expect((await s.asAdmin('DELETE', `/users/${s.viewer}`)).status).toBe(404)
  })

  test('the admin cannot be noted, revoked or deleted; viewers and tokens reach none of it', async () => {
    const s = await withViewer()
    for (const [method, path, body] of [
      ['PATCH', `/users/${s.admin}`, { note: 'x' }],
      ['POST', `/users/${s.admin}/revoke`],
      ['DELETE', `/users/${s.admin}`],
    ] as const) {
      const response = await s.asAdmin(method, path, body)
      expect([path, response.status, await response.json()]).toEqual([
        path,
        403,
        { error: '不能对管理员进行此操作' },
      ])
    }
    const rw = createToken(s.ctx.db, {
      user: s.admin,
      label: 'rw',
      permission: 'rw',
    }).secret
    for (const auth of [{ cookie: s.cookie }, { token: rw }])
      for (const [method, path] of [
        ['GET', '/users'],
        ['POST', `/users/${s.viewer}/revoke`],
        ['GET', '/invites'],
        ['POST', '/invites'],
        ['POST', `/invites/${s.viewer}/regenerate`],
      ] as const) {
        const response = await s.call(
          method,
          path,
          method === 'GET' ? undefined : { label: 'x' },
          auth,
        )
        expect([path, response.status]).toEqual([path, 403])
      }
    expect(
      s.ctx.db.select().from(users).where(eq(users.id, s.viewer)).get(),
    ).toMatchObject({ revokedAt: null })
  })
})
