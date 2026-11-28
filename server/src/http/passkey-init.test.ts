import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, test } from 'vitest'
import { newId } from '#db/id.ts'
import { passkeys } from '#db/schema.ts'
import { softAuthenticator } from '#testing/authenticator.ts'
import { testContext } from '#testing/context.ts'
import { recordingLogger } from '#testing/logs.ts'
import { adminId, createViewer, newHandle } from '#users/users.ts'
import { createApi } from './app.ts'
import { addOrigin } from './origins.ts'
import { logInitLink } from './passkey-init.ts'
import { createPasskeyTokens } from './passkeys.ts'
import type { AccountsContext } from '#accounts/accounts.ts'
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/server'

const MAIN = 'https://midden.test'
const OTHER = 'https://archive.example'
const GONE = { error: '链接已失效，请在 Telegram 中重新发送 /passkey' }
const SAID = 'no admin passkey yet; open this link to add one'

let ctx: AccountsContext | undefined
afterEach(async () => {
  await ctx?.queue.stop()
  ctx = undefined
})

function setup() {
  ctx = testContext()
  const db = ctx.db
  const key = randomBytes(32)
  addOrigin(db, `${MAIN}/`, OTHER)
  const notices: string[] = []
  /** A fresh API over the same database, as after a restart. */
  const api = (initKey = key, webAppUrl: string | undefined = `${MAIN}/`) =>
    createApi({
      ctx: ctx!,
      telegram: { token: '1:x', owner: '42' },
      webAppUrl,
      passkeyInitKey: initKey,
      notify: (text) => notices.push(text),
    })
  let app = api()
  /** The web process starting: what it logs. Null: no WEB_APP_URL. */
  const start = (url: string | null = `${MAIN}/`, initKey = key) => {
    const webAppUrl = url ?? undefined
    const { logger, entries } = recordingLogger()
    logInitLink({ db, logger, webAppUrl }, initKey)
    app = api(initKey, webAppUrl)
    return entries
  }
  const post = (path: string, body: unknown, origin = MAIN) =>
    app.request(path, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  async function registerWith(token: string, origin = MAIN) {
    const asked = await post(
      '/auth/passkey/register/options',
      { token },
      origin,
    )
    if (!asked.ok) return { response: asked, asked }
    const options = (await asked
      .clone()
      .json()) as PublicKeyCredentialCreationOptionsJSON
    const response = await post(
      '/auth/passkey/register',
      {
        token,
        name: '新电脑',
        response: softAuthenticator().create(options, origin),
      },
      origin,
    )
    return { response, asked }
  }
  /** Every value in every table, blobs as hex and base64url. */
  const everything = () =>
    (
      db.$client
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .all() as { name: string }[]
    )
      .flatMap(({ name }) =>
        db.$client.prepare(`SELECT * FROM "${name}"`).all(),
      )
      .flatMap((row) => Object.values(row as Record<string, unknown>))
      .map((value) =>
        value instanceof Uint8Array
          ? `${Buffer.from(value).toString('hex')} ${Buffer.from(value).toString('base64url')}`
          : String(value),
      )
      .join('\n')
  const tokenOf = (entries: ReturnType<typeof start>) =>
    (entries[0]!.link as string).split('/passkey#', 2)[1]!
  return { db, notices, start, post, registerWith, everything, tokenOf }
}

describe('the init link', () => {
  test('is logged once per start while the admin has no passkey, the same after a restart, and only a salt is kept', () => {
    const { start, everything, tokenOf } = setup()
    const first = start()
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ level: 30, msg: SAID })
    expect(first[0]!.link).toMatch(
      /^https:\/\/midden\.test\/passkey#[\dA-Z]{43}$/i,
    )
    const token = tokenOf(first)
    expect(start()).toEqual([expect.objectContaining({ link: first[0]!.link })])
    const stored = everything()
    expect(stored).not.toContain(token)
    expect(stored).not.toContain(Buffer.from(token).toString('hex'))
  })

  test('adds the admin a passkey once, signs them in, and is then gone for good', async () => {
    const { db, start, post, registerWith, notices, tokenOf } = setup()
    const token = tokenOf(start())
    const { response, asked } = await registerWith(token)
    expect(response.status).toBe(200)
    expect(await asked.text()).not.toContain(token)
    const body = await response.text()
    expect(body).not.toContain(token)
    expect(JSON.parse(body)).toMatchObject({
      name: '新电脑',
      rp_id: 'midden.test',
    })
    expect(response.headers.get('set-cookie')).toMatch(/^__Host-midden=/)
    expect(notices).toEqual(['已添加通行密钥：新电脑（midden.test）'])
    const owned = db.select().from(passkeys).all()
    expect(owned.map((p) => p.userId)).toEqual([adminId(db)])

    const again = await registerWith(token)
    expect(again.response.status).toBe(403)
    expect(await again.response.json()).toEqual(GONE)
    expect(start()).toEqual([])

    // With every passkey deleted, a start makes a new link; the old one
    // stays dead.
    db.delete(passkeys).run()
    const next = start()
    expect(next).toHaveLength(1)
    expect(tokenOf(next)).not.toBe(token)
    expect((await registerWith(token)).response.status).toBe(403)
    expect(
      (await post('/auth/passkey/register/options', { token: tokenOf(next) }))
        .status,
    ).toBe(200)
  })

  test('ends once the admin has a passkey made another way, before any restart', async () => {
    const { db, start, post, registerWith, tokenOf } = setup()
    const token = tokenOf(start())
    const [link] = createPasskeyTokens(db, [MAIN])
    expect((await registerWith(link!.token)).response.status).toBe(200)
    expect(
      await (await post('/auth/passkey/register/options', { token })).json(),
    ).toEqual(GONE)
    // Gone, not just hidden: losing that passkey brings the old link back
    // neither now nor after a restart.
    db.delete(passkeys).run()
    expect((await registerWith(token)).response.status).toBe(403)
    const next = start()
    expect(next).toHaveLength(1)
    expect(tokenOf(next)).not.toBe(token)
  })

  test("a viewer's passkey is not the admin's", async () => {
    const { db, start, registerWith, tokenOf } = setup()
    const first = start()
    const viewer = createViewer(db, {
      name: '朋友',
      note: '朋友',
      webauthnId: newHandle(),
    })
    db.insert(passkeys)
      .values({
        id: newId(),
        credentialId: 'viewer-credential',
        userId: viewer,
        rpId: 'midden.test',
        name: '朋友的手机',
        publicKey: Buffer.from('x'),
        counter: 0,
        transports: '[]',
        createdAt: new Date(),
      })
      .run()
    const second = start()
    expect(second).toEqual([expect.objectContaining({ link: first[0]!.link })])
    const { response } = await registerWith(tokenOf(second))
    expect(response.status).toBe(200)
    expect(
      db
        .select()
        .from(passkeys)
        .all()
        .filter((p) => p.userId === adminId(db)),
    ).toHaveLength(1)
  })

  test("is good on WEB_APP_URL's origin only, with its own challenges and SECRET_KEY's key", async () => {
    const { db, start, post, registerWith, tokenOf } = setup()
    const token = tokenOf(start())
    expect((await registerWith(token, OTHER)).response.status).toBe(403)
    // A challenge for the init link answers for no /passkey link.
    const options = (await (
      await post('/auth/passkey/register/options', { token })
    ).json()) as PublicKeyCredentialCreationOptionsJSON
    const [link] = createPasskeyTokens(db, [MAIN])
    const crossed = await post('/auth/passkey/register', {
      token: link!.token,
      name: 'x',
      response: softAuthenticator().create(options, MAIN),
    })
    expect(crossed.status).toBe(400)
    // Another SECRET_KEY: the old link is no good, and a new one is logged.
    const other = start(`${MAIN}/`, randomBytes(32))
    expect(tokenOf(other)).not.toBe(token)
    expect((await registerWith(token)).response.status).toBe(403)
  })

  test('without WEB_APP_URL logs the path and says it is needed', () => {
    const { start, tokenOf } = setup()
    const token = tokenOf(start())
    const entries = start(null)
    expect(entries).toEqual([
      expect.objectContaining({
        level: 30,
        path: `/passkey#${token}`,
        msg: 'no admin passkey yet; set WEB_APP_URL, then open this path on it to add one',
      }),
    ])
    expect(entries[0]).not.toHaveProperty('link')
  })
})
