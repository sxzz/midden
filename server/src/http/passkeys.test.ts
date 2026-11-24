import { afterEach, describe, expect, test, vi } from 'vitest'
import { passkeyTokens } from '#db/schema.ts'
import { fromOwner } from '#telegram/bot.ts'
import { handle, type Request } from '#telegram/commands.ts'
import { COMMANDS } from '#telegram/presentation.ts'
import { softAuthenticator } from '#testing/authenticator.ts'
import { testContext } from '#testing/context.ts'
import { createApi, SESSION_COOKIE } from './app.ts'
import { createToken } from './auth.ts'
import { TOKEN_TTL } from './passkeys.ts'
import type { AccountsContext } from '#accounts/accounts.ts'
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server'
import type { Message } from 'grammy/types'

const MAIN = 'https://midden.test'
const OTHER = 'https://archive.example'

let ctx: AccountsContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

function setup() {
  ctx = testContext()
  // /passkey runs on the real clock, as the bot does.
  let time = Date.now()
  const start = new Date(time).toISOString()
  const clock = {
    now: () => time,
    advance: (ms: number) => (time += ms),
    start,
  }
  const notices: string[] = []
  const app = createApi({
    ctx,
    telegram: { token: '1:x', owner: '42' },
    webOrigins: [MAIN, OTHER],
    notify: (text) => notices.push(text),
    now: clock.now,
  })
  const post = (
    path: string,
    body: unknown,
    origin = MAIN,
    headers: Record<string, string> = {},
  ) =>
    app.request(path, {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
    })
  /** /passkey from the owner's chat: the link token for each origin. */
  const links = () => {
    const reply = handle(
      { ctx: ctx!, webOrigins: [MAIN, OTHER], version: 'dev' },
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
    const urls = (reply.keyboard ?? [])
      .flat()
      .map((b) => ('url' in b ? b.url! : ''))
    return {
      reply,
      tokens: Object.fromEntries(
        urls.map((url) => [
          new URL(url).origin,
          url.split('#/passkey/', 2)[1]!,
        ]),
      ),
    }
  }
  async function registerWithLink(
    token: string,
    origin = MAIN,
    authenticator = softAuthenticator(),
    name = '测试设备',
  ) {
    const asked = await post(
      '/auth/passkey/register/options',
      { token },
      origin,
    )
    if (!asked.ok) return { response: asked, authenticator }
    const options =
      (await asked.json()) as PublicKeyCredentialCreationOptionsJSON
    const response = await post(
      '/auth/passkey/register',
      { token, name, response: authenticator.create(options, origin) },
      origin,
    )
    return { response, authenticator }
  }
  async function signIn(
    authenticator: ReturnType<typeof softAuthenticator>,
    origin = MAIN,
    rp?: string,
  ) {
    const options = (await (
      await post('/auth/passkey/options', {}, origin)
    ).json()) as PublicKeyCredentialRequestOptionsJSON
    return post(
      '/auth/passkey',
      { response: authenticator.get(options, origin, rp) },
      origin,
    )
  }
  const cookieOf = (response: Response) =>
    response.headers.get('set-cookie')?.split(';', 1)[0]
  return {
    ctx,
    app,
    clock,
    notices,
    post,
    links,
    registerWithLink,
    signIn,
    cookieOf,
  }
}

describe('/passkey links', () => {
  test('one button per domain, labelled with its host, and only digests kept', () => {
    const { ctx, links } = setup()
    const { reply, tokens } = links()
    expect(reply.text).toBe('添加通行密钥，10 分钟内有效。')
    expect(reply.keyboard!.map((row) => row[0]!.text)).toEqual([
      'midden.test',
      'archive.example',
    ])
    for (const token of Object.values(tokens)) {
      // At least 128 bits, base64url.
      expect(token).toMatch(/^[\w-]{43}$/)
      expect(
        JSON.stringify(ctx.db.select().from(passkeyTokens).all()),
      ).not.toContain(token)
    }
    expect(COMMANDS.find((c) => c.name === 'passkey')).toMatchObject({
      privateOnly: true,
    })
  })

  test('is for the owner in a private chat only', () => {
    const message = (from: number, chat: Message['chat']) =>
      ({ chat, message_id: 1, date: 0 }) as Message
    const owner = { id: 42, is_bot: false }
    expect(
      fromOwner(
        message(42, { id: 42, type: 'private', first_name: 'a' }),
        owner,
        '42',
      ),
    ).toBe(true)
    expect(
      fromOwner(
        message(7, { id: 7, type: 'private', first_name: 'b' }),
        { id: 7, is_bot: false },
        '42',
      ),
    ).toBe(false)
    const { ctx } = setup()
    expect(
      handle({ ctx, webOrigins: [MAIN], version: 'dev' }, {
        command: 'passkey',
        group: true,
      } as Request).text,
    ).toBe('请在私聊中使用此命令。')
    expect(ctx.db.select().from(passkeyTokens).all()).toHaveLength(0)
  })

  test('registers once, signs in, and is used up', async () => {
    const { links, registerWithLink, cookieOf, app, notices } = setup()
    const { tokens } = links()
    const first = await registerWithLink(tokens[MAIN]!)
    expect(first.response.status).toBe(200)
    expect(await first.response.json()).toMatchObject({
      name: '测试设备',
      rp_id: 'midden.test',
    })
    const cookie = cookieOf(first.response)!
    expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true)
    expect(first.response.headers.get('set-cookie')).toMatch(
      /HttpOnly.*Secure|Secure.*HttpOnly/,
    )
    expect(
      (await app.request('/session', { headers: { Cookie: cookie } })).status,
    ).toBe(204)
    expect(notices).toEqual(['已添加通行密钥：测试设备（midden.test）'])
    // The link is gone, for this and any other authenticator.
    const again = await registerWithLink(tokens[MAIN]!)
    expect(again.response.status).toBe(403)
    // The other domain's link is its own.
    expect(
      (await registerWithLink(tokens[OTHER]!, OTHER)).response.status,
    ).toBe(200)
  })

  test('expires after ten minutes, and a new /passkey replaces old links', async () => {
    const { links, post, clock, registerWithLink } = setup()
    const { tokens } = links()
    clock.advance(TOKEN_TTL + 1)
    expect(
      (await post('/auth/passkey/register/options', { token: tokens[MAIN] }))
        .status,
    ).toBe(403)
    const old = links().tokens
    links()
    expect((await registerWithLink(old[MAIN]!)).response.status).toBe(403)
  })

  test('a link expiring mid-ceremony registers nothing', async () => {
    const { links, post, clock } = setup()
    const { tokens } = links()
    const authenticator = softAuthenticator()
    clock.advance(TOKEN_TTL - 60_000)
    const options = (await (
      await post('/auth/passkey/register/options', { token: tokens[MAIN] })
    ).json()) as PublicKeyCredentialCreationOptionsJSON
    // The challenge is still good; the link is not.
    clock.advance(2 * 60_000)
    const response = await post('/auth/passkey/register', {
      token: tokens[MAIN],
      name: 'x',
      response: authenticator.create(options, MAIN),
    })
    expect(response.status).toBe(403)
  })

  test('a link works only on its own domain', async () => {
    const { links, post } = setup()
    const { tokens } = links()
    expect(
      (
        await post(
          '/auth/passkey/register/options',
          { token: tokens[MAIN] },
          OTHER,
        )
      ).status,
    ).toBe(403)
    expect(
      (await post('/auth/passkey/register/options', { token: 'a'.repeat(43) }))
        .status,
    ).toBe(403)
  })
})

describe('passkey login', () => {
  test('signs in on the domain it was made for, and counts up', async () => {
    const { links, registerWithLink, signIn, cookieOf, app } = setup()
    const { authenticator } = await registerWithLink(links().tokens[MAIN]!)
    const ok = await signIn(authenticator)
    expect(ok.status).toBe(204)
    const cookie = cookieOf(ok)!
    expect(
      (await app.request('/session', { headers: { Cookie: cookie } })).status,
    ).toBe(204)
    // A replayed or lower counter is refused.
    authenticator.counter = 0
    expect((await signIn(authenticator)).status).toBe(400)
  })

  test('a passkey from one domain does not sign in on another', async () => {
    const { links, registerWithLink, signIn } = setup()
    const { authenticator } = await registerWithLink(links().tokens[MAIN]!)
    // Not found among the other domain's passkeys.
    expect((await signIn(authenticator, OTHER)).status).toBe(400)
    // Claiming the other domain's RP ID does not pass either.
    expect((await signIn(authenticator, MAIN, 'archive.example')).status).toBe(
      400,
    )
  })

  test('needs user verification', async () => {
    const { links, post } = setup()
    const options = (await (
      await post('/auth/passkey/register/options', {
        token: links().tokens[MAIN],
      })
    ).json()) as PublicKeyCredentialCreationOptionsJSON
    expect(options.authenticatorSelection).toMatchObject({
      residentKey: 'required',
      userVerification: 'required',
    })
    const response = await post('/auth/passkey/register', {
      token: links().tokens[MAIN],
      name: 'x',
      response: softAuthenticator({ userVerified: false }).create(
        options,
        MAIN,
      ),
    })
    expect(response.status).toBe(400)
  })

  test('each challenge answers once and expires', async () => {
    const { links, registerWithLink, post, clock } = setup()
    const { authenticator } = await registerWithLink(links().tokens[MAIN]!)
    const options = (await (
      await post('/auth/passkey/options', {})
    ).json()) as PublicKeyCredentialRequestOptionsJSON
    const answer = authenticator.get(options, MAIN)
    expect((await post('/auth/passkey', { response: answer })).status).toBe(204)
    expect((await post('/auth/passkey', { response: answer })).status).toBe(400)
    const late = (await (
      await post('/auth/passkey/options', {})
    ).json()) as PublicKeyCredentialRequestOptionsJSON
    clock.advance(5 * 60 * 1000 + 1)
    expect(
      (await post('/auth/passkey', { response: authenticator.get(late, MAIN) }))
        .status,
    ).toBe(400)
  })

  test('only allowed origins get options, each with its own RP ID', async () => {
    const { post } = setup()
    expect(
      (await post('/auth/passkey/options', {}, 'https://evil.test')).status,
    ).toBe(403)
    const main = (await (
      await post('/auth/passkey/options', {})
    ).json()) as PublicKeyCredentialRequestOptionsJSON
    const other = (await (
      await post('/auth/passkey/options', {}, OTHER)
    ).json()) as PublicKeyCredentialRequestOptionsJSON
    expect([main.rpId, other.rpId]).toEqual(['midden.test', 'archive.example'])
    expect(main.userVerification).toBe('required')
  })

  test('is rate limited', async () => {
    const { post } = setup()
    const statuses = []
    for (let i = 0; i < 21; i++)
      statuses.push(
        (
          await post('/auth/passkey/options', {}, MAIN, {
            'CF-Connecting-IP': '1.2.3.4',
          })
        ).status,
      )
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true)
    expect(statuses[20]).toBe(429)
  })

  test('cookie sessions write from every allowed origin and no other', async () => {
    const { links, registerWithLink, cookieOf, app } = setup()
    const cookie = cookieOf(
      (await registerWithLink(links().tokens[MAIN]!)).response,
    )!
    const write = (origin: string) =>
      app.request('/tags/none', {
        method: 'DELETE',
        headers: { Cookie: cookie, Origin: origin },
      })
    expect((await write('https://evil.test')).status).toBe(403)
    expect((await write(MAIN)).status).not.toBe(403)
    expect((await write(OTHER)).status).not.toBe(403)
  })
})

describe('passkey management', () => {
  async function signedIn() {
    const s = setup()
    const { authenticator } = await s.registerWithLink(s.links().tokens[MAIN]!)
    const cookie = s.cookieOf(await s.signIn(authenticator))!
    s.notices.length = 0
    const call = (path: string, init: RequestInit = {}, origin = MAIN) =>
      s.app.request(path, {
        ...init,
        headers: {
          Cookie: cookie,
          Origin: origin,
          'Content-Type': 'application/json',
          ...init.headers,
        },
      })
    return { ...s, call, authenticator }
  }

  test('lists, renames and deletes, telling the owner', async () => {
    const { call, notices, signIn, authenticator, clock } = await signedIn()
    const list = (await (await call('/passkeys')).json()) as {
      id: string
      name: string
      rp_id: string
      created_at: string
      last_used_at?: string
    }[]
    expect(list).toEqual([
      {
        id: expect.any(String),
        name: '测试设备',
        rp_id: 'midden.test',
        created_at: clock.start,
        last_used_at: clock.start,
      },
    ])
    const id = list[0]!.id
    const renamed = await call(`/passkeys/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: '  笔记本  ' }),
    })
    expect(await renamed.json()).toMatchObject({ name: '笔记本' })
    expect(
      (
        await call(`/passkeys/${id}`, {
          method: 'PATCH',
          body: JSON.stringify({ name: ' ' }),
        })
      ).status,
    ).toBe(400)
    expect(notices).toEqual([])
    // Deleting the last one is allowed; it no longer signs in.
    expect((await call(`/passkeys/${id}`, { method: 'DELETE' })).status).toBe(
      204,
    )
    expect(notices).toEqual(['已删除通行密钥：笔记本（midden.test）'])
    expect(await (await call('/passkeys')).json()).toEqual([])
    expect((await call(`/passkeys/${id}`, { method: 'DELETE' })).status).toBe(
      404,
    )
    expect((await signIn(authenticator)).status).toBe(400)
  })

  test('adds a passkey for the current domain without a link', async () => {
    const { call, notices } = await signedIn()
    const authenticator = softAuthenticator()
    const options = (await (
      await call('/passkeys/options', { method: 'POST' }, OTHER)
    ).json()) as PublicKeyCredentialCreationOptionsJSON
    expect(options.rp.id).toBe('archive.example')
    const added = await call(
      '/passkeys',
      {
        method: 'POST',
        body: JSON.stringify({
          name: '手机',
          response: authenticator.create(options, OTHER),
        }),
      },
      OTHER,
    )
    expect(await added.json()).toMatchObject({ rp_id: 'archive.example' })
    expect(notices).toEqual(['已添加通行密钥：手机（archive.example）'])
    // The same authenticator is not offered twice on that domain.
    const next = (await (
      await call('/passkeys/options', { method: 'POST' }, OTHER)
    ).json()) as PublicKeyCredentialCreationOptionsJSON
    expect(next.excludeCredentials?.map((c) => c.id)).toEqual([
      authenticator.id,
    ])
  })

  test('a signed-in challenge does not register through a link, or the other way', async () => {
    const { call, post, links } = await signedIn()
    const options = (await (
      await call('/passkeys/options', { method: 'POST' })
    ).json()) as PublicKeyCredentialCreationOptionsJSON
    const response = await post('/auth/passkey/register', {
      token: links().tokens[MAIN],
      name: 'x',
      response: softAuthenticator().create(options, MAIN),
    })
    expect(response.status).toBe(403)
  })

  test('needs a session or token', async () => {
    const { app, ctx } = setup()
    expect((await app.request('/passkeys')).status).toBe(401)
    const token = createToken(ctx.db, 't')
    expect(
      (
        await app.request('/passkeys', {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(200)
  })
})

describe('the Telegram Login Widget', () => {
  test('is gone', async () => {
    const { app, post } = setup()
    expect((await app.request('/auth/telegram')).status).toBe(401)
    expect(
      (
        await post('/auth/telegram', {
          login: { id: '42', auth_date: '1', hash: 'a'.repeat(64) },
        })
      ).status,
    ).toBe(400)
  })
})

vi.setConfig({ testTimeout: 20_000 })
