import { Buffer } from 'node:buffer'
import process from 'node:process'
import { expect, test, type Page } from './test'

// A passkey's RP ID must be a domain name, so these pages run on localhost
// rather than the configured 127.0.0.1.
// The config exports the port it picked for this worktree.
const HOST = `localhost:${process.env.E2E_PORT}`
const APP = `http://${HOST}/app/`
const TOKEN = 'T'.repeat(43)
const challenge = (n: number) =>
  Buffer.from(`challenge-${n}-${'x'.repeat(20)}`).toString('base64url')

/** Chromium's software authenticator, with a passkey store and a fingerprint. */
async function virtualAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  const { authenticatorId } = await cdp.send(
    'WebAuthn.addVirtualAuthenticator',
    {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    },
  )
  return { cdp, authenticatorId }
}

test('a /passkey link adds a passkey, which then signs in', async ({
  page,
}) => {
  const { cdp, authenticatorId } = await virtualAuthenticator(page)
  const scripts: string[] = []
  await page.route('https://telegram.org/**', (r) => {
    scripts.push(r.request().url())
    return r.fulfill({ body: '', contentType: 'text/javascript' })
  })
  let session = false
  let issued = 0
  const registered: {
    token: string
    name: string
    response: { id: string }
  }[] = []
  const logins: {
    response: { id: string; response: { userHandle: string } }
  }[] = []
  await page.route('**/v1/**', (r) => {
    const request = r.request()
    const path = new URL(request.url()).pathname
    if (path === '/v1/session') {
      if (request.method() === 'DELETE') {
        session = false
        return r.fulfill({ status: 204 })
      }
      return session
        ? r.fulfill({ status: 204 })
        : r.fulfill({ status: 401, json: { error: '需要登录' } })
    }
    if (path === '/v1/auth/passkey/register/options') {
      expect(request.postDataJSON()).toEqual({ token: TOKEN })
      return r.fulfill({
        json: {
          rp: { name: 'Midden', id: 'localhost' },
          user: {
            id: Buffer.from('midden-owner').toString('base64url'),
            name: 'Midden',
            displayName: 'Midden',
          },
          challenge: challenge(++issued),
          pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
          timeout: 60_000,
          attestation: 'none',
          excludeCredentials: [],
          authenticatorSelection: {
            residentKey: 'required',
            requireResidentKey: true,
            userVerification: 'required',
          },
        },
      })
    }
    if (path === '/v1/auth/passkey/register') {
      registered.push(request.postDataJSON())
      session = true
      return r.fulfill({
        json: {
          id: 'p',
          name: registered[0]!.name,
          rp_id: 'localhost',
          created_at: '2026-11-25T00:00:00.000Z',
        },
      })
    }
    if (path === '/v1/auth/passkey/options')
      return r.fulfill({
        json: {
          rpId: 'localhost',
          challenge: challenge(++issued),
          timeout: 60_000,
          userVerification: 'required',
        },
      })
    if (path === '/v1/auth/passkey') {
      logins.push(request.postDataJSON())
      session = true
      return r.fulfill({ status: 204 })
    }
    if (path === '/v1/collections') return r.fulfill({ json: { items: [] } })
    return r.fulfill({ json: {} })
  })

  await page.goto(`${APP}#/passkey/${TOKEN}`)
  await expect(page.locator('h1')).toHaveText('添加通行密钥')
  // The page starts from a name with this domain in it.
  await expect(page.getByLabel('名称')).toHaveValue(new RegExp(`${HOST}$`))
  await page.getByLabel('名称').fill('测试电脑')
  await page.getByRole('button', { name: '创建通行密钥' }).click()
  await expect(page.locator('h1')).toHaveText('我的收藏')
  expect(registered).toEqual([
    {
      token: TOKEN,
      name: '测试电脑',
      response: expect.objectContaining({ id: expect.any(String) }),
    },
  ])
  const { credentials } = await cdp.send('WebAuthn.getCredentials', {
    authenticatorId,
  })
  expect(credentials).toHaveLength(1)
  expect(credentials[0]).toMatchObject({
    isResidentCredential: true,
    rpId: 'localhost',
  })
  // The link page itself asked telegram.org for nothing.
  expect(scripts.filter((s) => s.includes('telegram-widget'))).toEqual([])

  // Signed out, the same passkey signs in again with no name to type.
  session = false
  await page.goto(APP)
  await expect(
    page.getByText('首次使用请在 Telegram 中发送 /passkey'),
  ).toBeVisible()
  await page.screenshot({ path: 'test-results/passkey-login.png' })
  await page.getByRole('button', { name: '使用通行密钥登录' }).click()
  await expect(page.locator('h1')).toHaveText('我的收藏')
  expect(logins).toHaveLength(1)
  expect(logins[0]!.response.id).toBe(registered[0]!.response.id)
  expect(
    Buffer.from(
      logins[0]!.response.response.userHandle,
      'base64url',
    ).toString(),
  ).toBe('midden-owner')
})

test('a link that no longer works says so', async ({ page }) => {
  await page.route('**/v1/**', (r) =>
    r.fulfill({
      status: 403,
      json: { error: '链接已失效，请在 Telegram 中重新发送 /passkey' },
    }),
  )
  await page.goto(`${APP}#/passkey/${TOKEN}`)
  await page.getByRole('button', { name: '创建通行密钥' }).click()
  await expect(page.getByRole('alert')).toHaveText(
    '链接已失效，请在 Telegram 中重新发送 /passkey',
  )
})

test('the settings page lists, adds, renames and deletes passkeys', async ({
  page,
}) => {
  const { cdp, authenticatorId } = await virtualAuthenticator(page)
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  let passkeys = [
    {
      id: 'a',
      name: 'Mac Safari · midden.test',
      rp_id: 'midden.test',
      created_at: '2026-11-01T08:00:00.000Z',
      last_used_at: '2026-11-20T08:00:00.000Z',
    },
  ]
  await page.route('**/v1/**', (r) => {
    const request = r.request()
    const path = new URL(request.url()).pathname
    if (path === '/v1/session') return r.fulfill({ status: 204 })
    if (path === '/v1/accounts')
      return r.fulfill({ json: { platforms: [], accounts: [] } })
    if (path === '/v1/passkeys' && request.method() === 'GET')
      return r.fulfill({ json: passkeys })
    if (path === '/v1/origins')
      return r.fulfill({
        json: [{ origin: 'https://midden.test', passkeys: 0 }],
      })
    if (path === '/v1/passkeys/options')
      return r.fulfill({
        json: {
          rp: { name: 'Midden', id: 'localhost' },
          user: {
            id: Buffer.from('midden-owner').toString('base64url'),
            name: 'Midden',
            displayName: 'Midden',
          },
          challenge: challenge(1),
          pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
          attestation: 'none',
          authenticatorSelection: {
            residentKey: 'required',
            userVerification: 'required',
          },
        },
      })
    if (path === '/v1/passkeys') {
      const { name } = request.postDataJSON() as { name: string }
      const added = {
        id: 'b',
        name,
        rp_id: 'localhost',
        created_at: '2026-11-25T00:00:00.000Z',
      }
      passkeys = [...passkeys, added]
      return r.fulfill({ json: added })
    }
    const id = path.slice('/v1/passkeys/'.length)
    const method = request.method()
    if (method === 'DELETE') {
      passkeys = passkeys.filter((p) => p.id !== id)
      return r.fulfill({ status: 204 })
    }
    if (method === 'PATCH') {
      const { name } = request.postDataJSON() as { name: string }
      passkeys = passkeys.map((p) => (p.id === id ? { ...p, name } : p))
      return r.fulfill({ json: passkeys.find((p) => p.id === id) })
    }
    return r.fulfill({ json: { items: [] } })
  })
  await page.goto(`${APP}#/settings/passkeys`)
  const section = page.locator('section', { hasText: '通行密钥' })
  await expect(section).toContainText('Mac Safari · midden.test')
  await expect(section).toContainText('上次使用')

  await section.getByRole('button', { name: '添加通行密钥' }).click()
  await expect(section).toContainText(HOST)
  const { credentials } = await cdp.send('WebAuthn.getCredentials', {
    authenticatorId,
  })
  expect(credentials).toHaveLength(1)

  await page
    .getByRole('button', { name: '重命名 Mac Safari · midden.test' })
    .click()
  await page.locator('dialog[open] input').fill('旧电脑')
  await page.getByRole('button', { name: '保存' }).click()
  await expect(section).toContainText('旧电脑')

  await page.getByRole('button', { name: '删除 旧电脑' }).click()
  await page.getByRole('button', { name: '删除通行密钥' }).click()
  await expect(section).not.toContainText('旧电脑')
  await page.screenshot({ path: 'test-results/passkeys.png' })
})

test('the settings page adds a domain and removes it with its passkeys', async ({
  page,
}) => {
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  let origins: {
    id?: string
    origin: string
    passkeys: number
    created_at?: string
  }[] = [{ origin: 'https://midden.test', passkeys: 0 }]
  let passkeys = [
    {
      id: 'a',
      name: 'iPhone',
      rp_id: 'archive.example',
      created_at: '2026-11-01T08:00:00.000Z',
    },
  ]
  const added: unknown[] = []
  await page.route('**/v1/**', (r) => {
    const request = r.request()
    const path = new URL(request.url()).pathname
    if (path === '/v1/session') return r.fulfill({ status: 204 })
    if (path === '/v1/accounts')
      return r.fulfill({ json: { platforms: [], accounts: [] } })
    if (path === '/v1/passkeys') return r.fulfill({ json: passkeys })
    const method = request.method()
    if (path === '/v1/origins' && method === 'GET')
      return r.fulfill({ json: origins })
    if (path === '/v1/origins') {
      added.push(request.postDataJSON())
      const origin = {
        id: 'b',
        origin: 'https://archive.example',
        passkeys: 1,
        created_at: '2026-11-25T00:00:00.000Z',
      }
      origins = [...origins, origin]
      return r.fulfill({ json: origin })
    }
    if (path === '/v1/origins/b' && method === 'DELETE') {
      origins = origins.filter((o) => o.id !== 'b')
      passkeys = []
      return r.fulfill({ json: { passkeys: 1 } })
    }
    return r.fulfill({ json: { items: [] } })
  })
  await page.goto(`${APP}#/settings/admin`)
  const domains = page.locator('section', {
    has: page.getByRole('heading', { name: '域名', exact: true }),
  })
  await expect(domains).toContainText('midden.test')
  await expect(domains).toContainText('Mini App 地址')
  await expect(
    domains.getByRole('button', { name: '删除 midden.test' }),
  ).toHaveCount(0)

  await domains.getByRole('button', { name: '添加域名' }).click()
  const sheet = page.getByRole('dialog', { name: '添加域名' })
  await sheet.getByLabel('地址').fill('https://archive.example/app/')
  await sheet.getByRole('button', { name: '添加', exact: true }).click()
  await expect(domains).toContainText('archive.example')
  expect(added).toEqual([{ origin: 'https://archive.example/app/' }])

  await domains.getByRole('button', { name: '删除 archive.example' }).click()
  const confirm = page.getByRole('dialog', { name: '删除 archive.example？' })
  await expect(confirm).toContainText('将同时删除此域名的 1 个通行密钥')
  await confirm.getByRole('button', { name: '删除域名' }).click()
  await expect(domains).not.toContainText('archive.example')
  // The passkeys page reads them again when it is opened.
  await page.goto(`${APP}#/settings/passkeys`)
  const keys = page.locator('section', {
    has: page.getByRole('heading', { name: '通行密钥', exact: true }),
  })
  await expect(keys).toBeVisible()
  await expect(keys).not.toContainText('iPhone')
})
