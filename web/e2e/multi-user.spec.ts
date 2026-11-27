import { Buffer } from 'node:buffer'
import process from 'node:process'
import { folders, mockDesktop, POST_ID, PROFILE_ID } from './desktop-mock'
import { expect, test, type Page } from './test'

// Multi-user phase A in the web app: the admin's 用户 page and invites, what
// a viewer is shown (nothing they cannot use, no request they would be
// refused), and registering with an invite.

const VIEWER = {
  user: { id: 'v1', name: '小明', role: 'viewer' },
  can: {
    capture: false,
    organize: false,
    share: false,
    delete: false,
    admin: false,
  },
}
const ADMIN = {
  user: { id: 'a1', name: '管理员', role: 'admin' },
  can: {
    capture: true,
    organize: true,
    share: true,
    delete: true,
    admin: true,
  },
}

/**
 * What a viewer's session may ask of /v1 (the server's V1_FOR_VIEWERS, in
 * viewers.test.ts), and the mock's stand-in for media.
 */
const FOR_VIEWERS = [
  /^(GET|DELETE) \/session$/,
  /^GET \/collections(\/count|\/authors|\/perspectives|\/compare|\/graph)?$/,
  /^GET \/query\/suggest$/,
  /^GET \/(usage|folders)$/,
  /^GET \/collections\/[\w-]+(\/history(\/[\w-]+)?|\/counts|\/profile-changes|\/follows|\/follow-changes|\/graph)?$/,
  /^GET \/entities\/[\w-]+$/,
  /^(GET|POST|PATCH|DELETE) \/(passkeys|sessions|tokens)(\/.*)?$/,
  /^GET \/assets\//,
]

/** The desktop library, signed in as a viewer: the shared folder alone. */
async function asViewer(page: Page) {
  await mockDesktop(page)
  const refused: string[] = []
  await page.route('**/v1/**', (r) => {
    const request = r.request()
    const path = new URL(request.url()).pathname.replace(/^\/v1/, '')
    const call = `${request.method()} ${path}`
    if (FOR_VIEWERS.every((allowed) => !allowed.test(call))) {
      refused.push(call)
      return r.fulfill({ status: 403, json: { error: '查看者不能使用' } })
    }
    if (path === '/session') return r.fulfill({ json: VIEWER })
    // Shared folders as a viewer has them: no query, no filter.
    if (path === '/folders')
      return r.fulfill({
        json: [folders[0]].map(({ filter: _, ...shared }) => ({
          ...shared,
          counted_at: null,
          stale: false,
          created_at: '2026-11-01T00:00:00Z',
          updated_at: '2026-11-01T00:00:00Z',
        })),
      })
    if (path === '/tokens') return r.fulfill({ json: [] })
    return r.fallback()
  })
  return { refused }
}

/** Every button's and link's name on the page. */
const controls = (page: Page) =>
  page
    .locator('button:visible, a:visible')
    .evaluateAll((elements) =>
      elements.map((e) =>
        (e.getAttribute('aria-label') || e.textContent || '').trim(),
      ),
    )
const WRITES =
  /更新|删除|公开分享|存为收藏夹|另存为|保存条件|管理收藏夹|我的整理|编辑标签|管理员面板|^用户$|^采集$|采集记录|采集账号|恢复/

test.describe('a viewer', () => {
  test.use({ viewport: { width: 1280, height: 900 } })

  for (const path of [
    '/',
    '/?entity_type=x.profile,instagram.profile',
    `/folder/${folders[0]!.id}`,
    `/collection/${POST_ID}`,
    `/collection/${PROFILE_ID}`,
    `/collection/${PROFILE_ID}/history`,
    '/relations',
    '/settings',
    '/settings/passkeys',
    '/settings/tokens',
  ])
    test(`sees no control they cannot use on ${path}`, async ({ page }) => {
      const { refused } = await asViewer(page)
      await page.goto(path)
      await expect(page.locator('main h1, main h2').first()).toBeVisible()
      await page.waitForLoadState('networkidle')
      const names = await controls(page)
      expect(names.filter((name) => WRITES.test(name))).toEqual([])
      // Tags and notes are the admin's: none shown, none to filter by.
      await expect(page.getByText('标签', { exact: true })).toHaveCount(0)
      await expect(page.getByText('我的整理')).toHaveCount(0)
      expect(refused).toEqual([])
    })

  test('has the rail, 设置 and folders of a viewer', async ({ page }) => {
    const { refused } = await asViewer(page)
    await page.goto('/')
    // The rail: no 采集, and the account's menu has only 退出登录.
    const nav = page.getByRole('navigation', { name: '主导航' })
    await expect(nav.getByRole('link')).toHaveText(['探索', '关系', '设置'])
    await expect(page.locator('.account-meta')).toHaveText(/^查看者 · /)
    await page.getByRole('button', { name: '账号菜单' }).click()
    await expect(page.getByRole('menuitem')).toHaveText(['退出登录'])
    await page.keyboard.press('Escape')
    // 设置 has three sections.
    await page.goto('/settings')
    await expect(
      page.getByRole('navigation', { name: '设置的分区' }).getByRole('link'),
    ).toHaveText([/^通行密钥/, /^API令牌/, /^关于/])
    // The folder's list starts from the folder on the server, without its
    // filter in the address.
    const asked: string[] = []
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (url.pathname === '/v1/collections') asked.push(url.search)
    })
    await page.goto(`/folder/${folders[0]!.id}`)
    await expect(page.locator('h1')).toHaveText('风景摄影')
    await expect.poll(() => asked.length).toBeGreaterThan(0)
    expect(new URLSearchParams(asked[0]).get('folder')).toBe(folders[0]!.id)
    expect(new URL(page.url()).search).toBe('')
    expect(refused).toEqual([])
  })

  test('is led away from 采集 and 管理员面板', async ({ page }) => {
    const { refused } = await asViewer(page)
    await page.goto('/captures')
    await expect(page).toHaveURL(/\/$/)
    await expect(page.locator('h1')).toHaveText('收藏库')
    await page.goto('/settings/admin/users')
    await expect(page).toHaveURL(/\/settings$/)
    expect(refused).toEqual([])
  })

  test('compares accounts from 多选, and does nothing else there', async ({
    page,
  }) => {
    await asViewer(page)
    await page.goto('/?entity_type=x.profile,instagram.profile')
    await page.getByRole('button', { name: '多选' }).click()
    const bar = page.getByRole('region', { name: '多选' })
    await expect(bar.getByRole('button')).toHaveText(['取消', '全选', ''])
    await expect(bar.getByRole('button', { name: '更新' })).toHaveCount(0)
  })

  test('makes read-only tokens only', async ({ page }) => {
    await asViewer(page)
    await page.goto('/settings/tokens')
    await page.getByRole('button', { name: '创建令牌' }).click()
    const dialog = page.getByRole('dialog', { name: '创建令牌' })
    await expect(dialog.getByText('只读，只能用于Agent API')).toBeVisible()
    await expect(dialog.getByRole('radio')).toHaveCount(0)
  })
})

test('a viewer on a phone has the bar without 采集, and pages without writes', async ({
  page,
}) => {
  const { refused } = await asViewer(page)
  for (const path of ['/', `/collection/${PROFILE_ID}`, '/settings']) {
    await page.goto(path)
    await expect(page.locator('main h1').first()).toBeVisible()
    await page.waitForLoadState('networkidle')
    const names = await controls(page)
    expect(
      names.filter((name) => WRITES.test(name)),
      path,
    ).toEqual([])
  }
  await expect(
    page.getByRole('navigation', { name: '主导航' }).getByRole('link'),
  ).toHaveText(['探索', '关系', '设置'])
  expect(refused).toEqual([])
})

test.describe('the admin', () => {
  test.use({ viewport: { width: 1280, height: 900 } })

  test('invites, renames, revokes and deletes on 用户', async ({ page }) => {
    await mockDesktop(page)
    const sent: string[] = []
    const now = Date.now()
    let users = [
      {
        id: 'a1',
        name: '管理员',
        role: 'admin',
        created_at: '2026-01-01T00:00:00Z',
        revoked_at: null as string | null,
        passkeys: 1,
        sessions: 1,
        tokens: 1,
      },
      {
        id: 'v1',
        name: '小明',
        role: 'viewer',
        created_at: '2026-11-20T00:00:00Z',
        revoked_at: null as string | null,
        passkeys: 2,
        sessions: 3,
        tokens: 1,
      },
    ]
    let invites: object[] = []
    await page.route('**/v1/**', (r) => {
      const request = r.request()
      const path = new URL(request.url()).pathname.replace(/^\/v1/, '')
      const method = request.method()
      if (method !== 'GET') sent.push(`${method} ${path}`)
      if (path === '/session') return r.fulfill({ json: ADMIN })
      if (path === '/users') return r.fulfill({ json: users })
      if (path === '/invites' && method === 'GET')
        return r.fulfill({ json: invites })
      if (path === '/invites') {
        const invite = {
          id: 'i1',
          label: request.postDataJSON().label,
          created_at: new Date(now).toISOString(),
          expires_at: new Date(now + 7 * 86_400_000).toISOString(),
        }
        invites = [invite]
        return r.fulfill({
          json: { invite, url: 'https://midden.test/invite#secret-token' },
        })
      }
      if (path === '/invites/i1') {
        invites = []
        return r.fulfill({ status: 204 })
      }
      if (path === '/users/v1' && method === 'PATCH') {
        users = users.map((u) =>
          u.id === 'v1' ? { ...u, name: request.postDataJSON().name } : u,
        )
        return r.fulfill({ json: users[1] })
      }
      if (path === '/users/v1/revoke') {
        users = users.map((u) =>
          u.id === 'v1'
            ? {
                ...u,
                revoked_at: '2026-11-28T00:00:00Z',
                passkeys: 0,
                sessions: 0,
                tokens: 0,
              }
            : u,
        )
        return r.fulfill({ json: users[1] })
      }
      if (path === '/users/v1') {
        users = users.filter((u) => u.id !== 'v1')
        return r.fulfill({ status: 204 })
      }
      return r.fallback()
    })
    // From the account's menu.
    await page.goto('/settings/admin')
    await expect(
      page.getByRole('link', { name: /^用户\s*查看者与邀请/ }),
    ).toBeVisible()
    await page.getByRole('button', { name: '账号菜单' }).click()
    await expect(page.getByRole('menuitem')).toHaveText([
      '管理员面板',
      '用户',
      '退出登录',
    ])
    await page.getByRole('menuitem', { name: '用户' }).click()
    await expect(page).toHaveURL(/\/settings\/admin\/users$/)
    const pane = page.getByRole('region', { name: '用户' })
    await expect(pane.locator('.user')).toHaveCount(2)
    await expect(pane.locator('.user').first()).toContainText('管理员')
    // The admin's own row is no button: nothing to do to them.
    await expect(pane.locator('button.user')).toHaveCount(1)
    await expect(pane.locator('button.user')).toContainText(
      '2个通行密钥、3个登录、1个令牌',
    )

    // An invite: its label, then the link, once.
    await pane.getByRole('button', { name: '邀请' }).click()
    const form = page.getByRole('dialog', { name: '邀请' })
    await form.getByRole('textbox').fill('小红')
    await form.getByRole('button', { name: '生成链接' }).click()
    const link = page.getByRole('dialog', { name: '邀请小红' })
    await expect(link.getByRole('textbox')).toHaveValue(
      'https://midden.test/invite#secret-token',
    )
    await expect(link).toContainText('链接只显示这一次。')
    await link.getByRole('button', { name: '复制链接' }).click()
    await expect(
      page.getByRole('status').filter({ hasText: /复制链接/ }),
    ).toBeVisible()
    await link.getByRole('button', { name: '关闭' }).click()
    await expect(link).toBeHidden()
    const invite = pane.locator('.invite')
    await expect(invite).toContainText('小红')
    await expect(invite).toContainText(/剩(6天23小时|7天)/)
    await invite.getByRole('button', { name: '撤销邀请小红' }).click()
    const revokeInvite = page.getByRole('dialog', { name: '撤销邀请小红？' })
    await revokeInvite.getByRole('button', { name: '撤销邀请' }).click()
    await expect(invite).toHaveCount(0)

    // 改名.
    await pane.locator('button.user').click()
    await page.getByRole('menuitem', { name: '改名' }).click()
    const rename = page.getByRole('dialog', { name: '改名' })
    await rename.getByRole('textbox').fill('小明明')
    await rename.getByRole('button', { name: '保存' }).click()
    await expect(pane.locator('button.user')).toContainText('小明明')

    // 撤销, saying what it takes.
    await pane.locator('button.user').click()
    await page.getByRole('menuitem', { name: '撤销' }).click()
    const revoke = page.getByRole('dialog', { name: '撤销小明明？' })
    await expect(revoke).toContainText(
      '将删除2个通行密钥、3个登录、1个令牌，立即退出，用户保留为已撤销。',
    )
    await revoke.getByRole('button', { name: '撤销', exact: true }).click()
    await expect(pane.locator('button.user')).toContainText('已撤销')
    await expect(pane.locator('.user.revoked')).toHaveCount(1)

    // 删除 a revoked user.
    await pane.locator('button.user').click()
    await expect(page.getByRole('menuitem', { name: '撤销' })).toHaveCount(0)
    await page.getByRole('menuitem', { name: '删除' }).click()
    const remove = page.getByRole('dialog', { name: '删除小明明？' })
    await expect(remove).toContainText('将删除这个用户和')
    await remove.getByRole('button', { name: '删除', exact: true }).click()
    await expect(pane.locator('.user')).toHaveCount(1)
    expect(sent).toEqual([
      'POST /invites',
      'DELETE /invites/i1',
      'PATCH /users/v1',
      'POST /users/v1/revoke',
      'DELETE /users/v1',
    ])
  })
})

// A passkey's RP ID must be a domain name: these run on localhost.
const APP = `http://localhost:${process.env.E2E_PORT}/`
const TOKEN = 'I'.repeat(43)

async function virtualAuthenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page)
  // WebAuthn answers only a focused page; in a shared browser (E2E_CDP),
  // other tests' tabs take the focus.
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
}

test('an invite registers a viewer, who lands signed in', async ({ page }) => {
  await virtualAuthenticator(page)
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  let session = false
  const options: object[] = []
  const joined: Record<string, unknown>[] = []
  await page.route('**/v1/**', (r) => {
    const request = r.request()
    const path = new URL(request.url()).pathname
    if (path === '/v1/session')
      return session
        ? r.fulfill({ json: VIEWER })
        : r.fulfill({ status: 401, json: { error: '需要登录' } })
    if (path === '/v1/auth/invite/options') {
      const body = request.postDataJSON()
      options.push(body)
      return r.fulfill({
        json: {
          rp: { name: 'Midden', id: 'localhost' },
          user: {
            id: Buffer.from('viewer-handle').toString('base64url'),
            name: body.name ?? '小红',
            displayName: body.name ?? '小红',
          },
          challenge: Buffer.from(
            `challenge-${options.length}-xxxxxxxxxx`,
          ).toString('base64url'),
          pubKeyCredParams: [
            { alg: -7, type: 'public-key' },
            { alg: -257, type: 'public-key' },
          ],
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
    if (path === '/v1/auth/invite') {
      joined.push(request.postDataJSON())
      session = true
      return r.fulfill({ json: { user: VIEWER.user } })
    }
    if (path === '/v1/collections') return r.fulfill({ json: { items: [] } })
    if (path === '/v1/folders') return r.fulfill({ json: [] })
    return r.fulfill({ json: {} })
  })

  await page.goto(`${APP}invite#${TOKEN}`)
  await expect(page.locator('h1')).toHaveText('加入Midden')
  // The invite's label is the name to start from.
  await expect(page.getByLabel('名字')).toHaveValue('小红')
  await expect(page.getByLabel('通行密钥名称')).toHaveValue(/localhost/)
  await page.getByLabel('名字').fill('小红红')
  await page.getByRole('button', { name: '创建通行密钥' }).click()
  await expect(page.locator('h1')).toHaveText('收藏库')
  await expect(page).toHaveURL(APP)
  expect(options).toEqual([{ token: TOKEN }, { token: TOKEN, name: '小红红' }])
  expect(joined).toEqual([
    {
      token: TOKEN,
      name: '小红红',
      passkey_name: expect.stringContaining('localhost'),
      response: expect.objectContaining({ id: expect.any(String) }),
    },
  ])
  // Signed in as the viewer: no 采集.
  await expect(page.getByRole('link', { name: '采集' })).toHaveCount(0)
})

test("an invite no longer good says the server's reason", async ({ page }) => {
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (r) =>
    new URL(r.request().url()).pathname === '/v1/auth/invite/options'
      ? r.fulfill({ status: 403, json: { error: '邀请链接已失效' } })
      : r.fulfill({ status: 401, json: { error: '需要登录' } }),
  )
  await page.goto(`${APP}invite#${TOKEN}`)
  await expect(page.getByRole('alert')).toHaveText('邀请链接已失效')
  await expect(page.getByRole('button', { name: '创建通行密钥' })).toHaveCount(
    0,
  )
})
