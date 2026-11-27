import { Buffer } from 'node:buffer'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { passkeys, passkeyTokens } from '#db/schema.ts'
import { fromOwner } from '#telegram/bot.ts'
import { handle, type Request } from '#telegram/commands.ts'
import { COMMANDS } from '#telegram/presentation.ts'
import { softAuthenticator } from '#testing/authenticator.ts'
import { testContext } from '#testing/context.ts'
import { tokenSecret } from '#testing/tokens.ts'
import { createApi, SESSION_COOKIE } from './app.ts'
import { addOrigin } from './origins.ts'
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
  // The API and /passkey share this clock, so link expiry is exact.
  let time = Date.now()
  const start = new Date(time).toISOString()
  const clock = {
    now: () => time,
    advance: (ms: number) => (time += ms),
    start,
  }
  addOrigin(ctx.db, `${MAIN}/app/`, OTHER)
  const notices: string[] = []
  const app = createApi({
    ctx,
    telegram: { token: '1:x', owner: '42' },
    webAppUrl: `${MAIN}/app/`,
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
      {
        ctx: ctx!,
        webAppUrl: `${MAIN}/app/`,
        version: 'dev',
        now: clock.now,
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
    const urls = (reply.keyboard ?? [])
      .flat()
      .map((b) => ('url' in b ? b.url! : ''))
    return {
      reply,
      tokens: Object.fromEntries(
        urls.map((url) => [
          new URL(url).origin,
          url.split('/app/passkey#', 2)[1]!,
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
      handle({ ctx, webAppUrl: `${MAIN}/app/`, version: 'dev' }, {
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
    ).toBe(200)
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
    ).toBe(200)
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

  test('a challenge works only as issued: untampered, for its purpose and origin', async () => {
    const { links, registerWithLink, post } = setup()
    const { authenticator } = await registerWithLink(links().tokens[MAIN]!)
    const options = async (origin = MAIN) =>
      (await (
        await post('/auth/passkey/options', {}, origin)
      ).json()) as PublicKeyCredentialRequestOptionsJSON
    const answer = (request: PublicKeyCredentialRequestOptionsJSON) =>
      post('/auth/passkey', { response: authenticator.get(request, MAIN) })

    const tampered = await options()
    const bytes = Buffer.from(tampered.challenge, 'base64url')
    bytes[20]! ^= 1
    expect(
      (await answer({ ...tampered, challenge: bytes.toString('base64url') }))
        .status,
    ).toBe(400)
    // Issued for the other domain.
    const other = await options(OTHER)
    expect((await answer({ ...other, rpId: 'midden.test' })).status).toBe(400)
    // A registration challenge does not sign in.
    const registration = (await (
      await post('/auth/passkey/register/options', {
        token: links().tokens[MAIN],
      })
    ).json()) as PublicKeyCredentialCreationOptionsJSON
    expect(
      (
        await answer({
          challenge: registration.challenge,
          rpId: 'midden.test',
        })
      ).status,
    ).toBe(400)
    expect((await answer(await options())).status).toBe(204)
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

  test('is not rate limited', async () => {
    const { post } = setup()
    for (let i = 0; i < 80; i++)
      expect(
        (
          await post('/auth/passkey/options', {}, MAIN, {
            'CF-Connecting-IP': '1.2.3.4',
          })
        ).status,
      ).toBe(200)
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

  test('deleting a passkey can sign out every other session', async () => {
    const s = await signedIn()
    const { call, signIn, authenticator, cookieOf } = s
    const sessionsOf = async () =>
      ((await (await call('/sessions')).json()) as { current: boolean }[])
        .length
    // The link signed in too, and two more browsers.
    const second = cookieOf(await signIn(authenticator))!
    cookieOf(await signIn(authenticator))
    expect(await sessionsOf()).toBe(4)
    const [passkey] = (await (await call('/passkeys')).json()) as {
      id: string
    }[]
    expect(
      (
        await call(`/passkeys/${passkey!.id}?sign_out_others=yes`, {
          method: 'DELETE',
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await call(`/passkeys/${passkey!.id}?sign_out_others=true`, {
          method: 'DELETE',
        })
      ).status,
    ).toBe(204)
    const left = (await (await call('/sessions')).json()) as {
      current: boolean
      method: string
    }[]
    expect(left).toEqual([
      expect.objectContaining({ current: true, method: 'passkey' }),
    ])
    expect(
      (await s.app.request('/session', { headers: { Cookie: second } })).status,
    ).toBe(401)
    // Without the option, other sessions stay.
    const other = softAuthenticator()
    const options = (await (
      await call('/passkeys/options', { method: 'POST' })
    ).json()) as PublicKeyCredentialCreationOptionsJSON
    const added = (await (
      await call('/passkeys', {
        method: 'POST',
        body: JSON.stringify({
          name: '手机',
          response: other.create(options, MAIN),
        }),
      })
    ).json()) as { id: string }
    cookieOf(await signIn(other))
    expect(await sessionsOf()).toBe(2)
    await call(`/passkeys/${added.id}`, { method: 'DELETE' })
    expect(await sessionsOf()).toBe(2)
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
    const { call, post, links, app, signIn, authenticator, cookieOf } =
      await signedIn()
    const signedInOptions = (await (
      await call('/passkeys/options', { method: 'POST' })
    ).json()) as PublicKeyCredentialCreationOptionsJSON
    const token = links().tokens[MAIN]!
    expect(
      (
        await post('/auth/passkey/register', {
          token,
          name: 'x',
          response: softAuthenticator().create(signedInOptions, MAIN),
        })
      ).status,
    ).toBe(400)
    const linkOptions = (await (
      await post('/auth/passkey/register/options', { token })
    ).json()) as PublicKeyCredentialCreationOptionsJSON
    expect(
      (
        await call('/passkeys', {
          method: 'POST',
          body: JSON.stringify({
            name: 'x',
            response: softAuthenticator().create(linkOptions, MAIN),
          }),
        })
      ).status,
    ).toBe(400)
    // Nor through another session.
    const other = cookieOf(await signIn(authenticator))!
    const response = await app.request('/passkeys', {
      method: 'POST',
      headers: {
        Cookie: other,
        Origin: MAIN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'x',
        response: softAuthenticator().create(signedInOptions, MAIN),
      }),
    })
    expect(response.status).toBe(400)
  })

  test('needs the web session: no API token adds a passkey to sign in with', async () => {
    const { app, ctx, links, registerWithLink, signIn } = setup()
    expect((await app.request('/passkeys')).status).toBe(401)
    const attacker = softAuthenticator()
    for (const permission of ['rw', 'ro'] as const) {
      const as = (path: string, method = 'GET', body?: unknown) =>
        app.request(path, {
          method,
          headers: {
            Authorization: `Bearer ${tokenSecret(ctx.db, permission)}`,
            Origin: MAIN,
            'Content-Type': 'application/json',
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      expect((await as('/passkeys')).status).toBe(403)
      const options = await as('/passkeys/options', 'POST')
      expect(options.status).toBe(403)
      expect(await options.json()).toEqual({
        error:
          permission === 'rw'
            ? '只能在网页中登录后进行此操作'
            : '只读令牌不能修改内容',
      })
      const challenge = Buffer.from('not issued').toString('base64url')
      const made = attacker.create(
        {
          challenge,
          rp: { id: 'midden.test', name: 'Midden' },
          user: { id: 'eA', name: 'x', displayName: 'x' },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        },
        MAIN,
      )
      expect(
        (await as('/passkeys', 'POST', { name: 'x', response: made })).status,
      ).toBe(403)
      expect((await as('/passkeys/nope', 'PATCH', { name: 'x' })).status).toBe(
        403,
      )
    }
    expect(ctx.db.select().from(passkeys).all()).toEqual([])
    expect((await signIn(attacker)).status).toBe(400)
    // A /passkey link still makes one, which signs in.
    const { response, authenticator } = await registerWithLink(
      links().tokens[MAIN]!,
    )
    expect(response.status).toBe(200)
    expect((await signIn(authenticator)).status).toBe(204)
  })

  test('domains: lists, adds normalized https origins, refuses others', async () => {
    const { call, notices } = await signedIn()
    const list = async () =>
      (await (await call('/origins')).json()) as {
        id?: string
        origin: string
        passkeys: number
      }[]
    expect(await list()).toEqual([
      { origin: MAIN, passkeys: 0 },
      {
        id: expect.any(String),
        origin: OTHER,
        passkeys: 0,
        created_at: expect.any(String),
      },
    ])
    const add = (origin: string) =>
      call('/origins', { method: 'POST', body: JSON.stringify({ origin }) })
    const added = await add('  https://New.Example/app/?x=1#y ')
    expect(await added.json()).toMatchObject({
      origin: 'https://new.example',
      passkeys: 0,
    })
    expect(notices).toEqual(['已添加域名：new.example'])
    for (const bad of [
      'http://plain.test',
      'ftp://x.test',
      'x.test',
      'https://user:pw@x.test',
      '',
    ])
      expect((await add(bad)).status).toBe(400)
    for (const dup of [MAIN, `${OTHER}/`, 'https://new.example'])
      expect((await add(dup)).status).toBe(409)
    expect((await list()).map((o) => o.origin)).toEqual([
      MAIN,
      OTHER,
      'https://new.example',
    ])
    expect((await call('/origins/nope', { method: 'DELETE' })).status).toBe(404)
    // A new domain can write and gets its own /passkey button.
    expect(
      (await call('/tags/none', { method: 'DELETE' }, 'https://new.example'))
        .status,
    ).not.toBe(403)
  })

  test('the bot offers a /passkey link for each domain in the list', async () => {
    const { call, links } = await signedIn()
    await call('/origins', {
      method: 'POST',
      body: JSON.stringify({ origin: 'https://new.example' }),
    })
    expect(links().reply.keyboard!.map((row) => row[0]!.text)).toEqual([
      'midden.test',
      'archive.example',
      'new.example',
    ])
    const id = (
      (await (await call('/origins')).json()) as { id?: string }[]
    )[1]!.id!
    await call(`/origins/${id}`, { method: 'DELETE' })
    expect(links().reply.keyboard!.map((row) => row[0]!.text)).toEqual([
      'midden.test',
      'new.example',
    ])
  })

  test('removing a domain deletes its passkeys and voids its links', async () => {
    const { call, notices, links, registerWithLink, signIn, post } =
      await signedIn()
    const { authenticator } = await registerWithLink(
      links().tokens[OTHER]!,
      OTHER,
    )
    expect((await signIn(authenticator, OTHER)).status).toBe(204)
    const outstanding = links().tokens[OTHER]!
    const other = (
      (await (await call('/origins')).json()) as {
        id?: string
        origin: string
        passkeys: number
      }[]
    ).find((o) => o.origin === OTHER)!
    expect(other.passkeys).toBe(1)
    // The built-in domain is not removable.
    expect(
      (await call(`/origins/${encodeURIComponent(MAIN)}`, { method: 'DELETE' }))
        .status,
    ).toBe(404)
    notices.length = 0
    const removed = await call(`/origins/${other.id}`, { method: 'DELETE' })
    expect(await removed.json()).toEqual({ passkeys: 1 })
    expect(notices).toEqual([
      '已删除域名：archive.example，同时删除了 1 个通行密钥',
    ])
    expect(
      ((await (await call('/passkeys')).json()) as { rp_id: string }[]).map(
        (p) => p.rp_id,
      ),
    ).toEqual(['midden.test'])
    expect((await signIn(authenticator, OTHER)).status).toBe(403)
    expect(
      (
        await post(
          '/auth/passkey/register/options',
          { token: outstanding },
          OTHER,
        )
      ).status,
    ).toBe(403)
    // Re-adding the domain brings neither back.
    await call('/origins', {
      method: 'POST',
      body: JSON.stringify({ origin: OTHER }),
    })
    expect((await signIn(authenticator, OTHER)).status).toBe(400)
    expect(
      (
        await post(
          '/auth/passkey/register/options',
          { token: outstanding },
          OTHER,
        )
      ).status,
    ).toBe(403)
  })

  test('writes from a removed or unlisted domain are refused', async () => {
    const { call } = await signedIn()
    const id = (
      (await (await call('/origins')).json()) as { id?: string }[]
    )[1]!.id!
    expect((await call(`/origins/${id}`, { method: 'DELETE' })).status).toBe(
      200,
    )
    for (const origin of [OTHER, 'https://evil.test'])
      expect(
        (await call('/tags/none', { method: 'DELETE' }, origin)).status,
      ).toBe(403)
    expect((await call('/tags/none', { method: 'DELETE' })).status).not.toBe(
      403,
    )
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
