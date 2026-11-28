import { Buffer } from 'node:buffer'
import process from 'node:process'
import { folders, mockDesktop, POST_ID, PROFILE_ID } from './desktop-mock'
import { expect, test, type Page } from './test'

// Multi-user phase A in the web app: the admin's 用户 page and invites, what
// a viewer is shown (nothing they cannot use, no request they would be
// refused), their own nickname, and registering with an invite.

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
  /^(GET|PATCH|DELETE) \/session$/,
  /^GET \/collections(\/count|\/authors|\/perspectives|\/compare|\/graph)?$/,
  /^GET \/query\/suggest$/,
  /^GET \/(folders|library\/stats)$/,
  /^GET \/collections\/[\w-]+(\/history(\/[\w-]+)?|\/counts|\/profile-changes|\/follows|\/follow-changes|\/graph)?$/,
  /^GET \/entities\/[\w-]+$/,
  /^(GET|POST|PATCH|DELETE) \/(passkeys|sessions|tokens)(\/.*)?$/,
  /^GET \/assets\//,
]

/** The desktop library, signed in as a viewer: the shared folder alone. */
async function asViewer(page: Page) {
  await mockDesktop(page)
  const refused: string[] = []
  const nicknames: string[] = []
  await page.route('**/v1/**', (r) => {
    const request = r.request()
    const path = new URL(request.url()).pathname.replace(/^\/v1/, '')
    const call = `${request.method()} ${path}`
    if (FOR_VIEWERS.every((allowed) => !allowed.test(call))) {
      refused.push(call)
      return r.fulfill({ status: 403, json: { error: '查看者不能使用' } })
    }
    if (path === '/session' && request.method() === 'PATCH') {
      nicknames.push(request.postDataJSON().name)
      return r.fulfill({
        json: { ...VIEWER, user: { ...VIEWER.user, name: nicknames.at(-1) } },
      })
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
    // The archive's counts, today's captures and updates too.
    if (path === '/library/stats')
      return r.fulfill({
        json: {
          posts: 1280,
          accounts: 42,
          with_images: 900,
          with_videos: 120,
          used_bytes: 12_800_000_000,
          saved_today: 3,
          saved_this_week: 17,
          captures_today: 4,
          updates_today: 2,
        },
      })
    return r.fallback()
  })
  return { refused, nicknames }
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
    '/settings/account',
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
    // The rail: no 采集, and the account's menu has their nickname and
    // 退出登录.
    const nav = page.getByRole('navigation', { name: '主导航' })
    await expect(nav.getByRole('link')).toHaveText(['探索', '关系', '设置'])
    await expect(page.locator('.account-meta')).toHaveText(/^查看者 · /)
    await page.getByRole('button', { name: '账号菜单' }).click()
    await expect(page.getByRole('menuitem')).toHaveText([
      '修改昵称',
      '退出登录',
    ])
    await page.keyboard.press('Escape')
    // 设置 has four sections.
    await page.goto('/settings')
    await expect(
      page.getByRole('navigation', { name: '设置的分区' }).getByRole('link'),
    ).toHaveText([/^账号/, /^通行密钥/, /^API令牌/, /^关于/])
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

  test('sees 全站统计 in full, today’s captures and updates too', async ({
    page,
  }) => {
    const { refused } = await asViewer(page)
    await page.goto('/')
    const stats = page.getByRole('region', { name: '全站统计' })
    await expect(stats.locator('dt')).toHaveText([
      '帖子',
      '账号',
      '含图片的帖子',
      '含视频的帖子',
      '今天新增',
      '本周新增',
      '今天采集',
      '今天更新',
    ])
    await expect(stats).toContainText('1,280')
    await expect(stats).toContainText('已用空间')
    // No 已用 line over the list: 全站统计 says it.
    await expect(page.locator('main').getByText(/^已用/)).toHaveCount(0)
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

  test('sets their own nickname, from the rail and from 设置', async ({
    page,
  }) => {
    const { refused, nicknames } = await asViewer(page)
    await page.goto('/')
    await expect(page.locator('.account-name')).toHaveText('小明')
    await page.getByRole('button', { name: '账号菜单' }).click()
    await page.getByRole('menuitem', { name: '修改昵称' }).click()
    const sheet = page.getByRole('dialog', { name: '昵称' })
    await expect(sheet.getByRole('textbox')).toHaveValue('小明')
    await sheet.getByRole('textbox').fill('明明')
    await sheet.getByRole('button', { name: '保存' }).click()
    await expect(sheet).toBeHidden()
    await expect(
      page.getByRole('status').filter({ hasText: '已保存昵称' }),
    ).toBeVisible()
    await expect(page.locator('.account-name')).toHaveText('明明')
    // 设置 → 账号 shows it, and changes it too.
    await page.getByRole('link', { name: '设置' }).first().click()
    await page
      .getByRole('navigation', { name: '设置的分区' })
      .getByRole('link', { name: /^账号/ })
      .click()
    const row = page.getByRole('button', { name: /^昵称/ })
    await expect(row).toContainText('明明')
    await row.click()
    await sheet.getByRole('textbox').fill('小明明')
    await sheet.getByRole('button', { name: '保存' }).click()
    await expect(row).toContainText('小明明')
    expect(nicknames).toEqual(['明明', '小明明'])
    expect(refused).toEqual([])
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

  test('invites, shows and makes links again, notes, revokes and deletes on 用户', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await mockDesktop(page)
    const sent: string[] = []
    const now = Date.now()
    let users = [
      {
        id: 'a1',
        name: '管理员',
        note: null as string | null,
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
        note: '同事' as string | null,
        role: 'viewer',
        created_at: '2026-11-20T00:00:00Z',
        revoked_at: null as string | null,
        passkeys: 2,
        sessions: 3,
        tokens: 1,
      },
    ]
    let invites: { url: string }[] = []
    let made = 0
    await page.route('**/v1/**', (r) => {
      const request = r.request()
      const path = new URL(request.url()).pathname.replace(/^\/v1/, '')
      const method = request.method()
      if (method !== 'GET') sent.push(`${method} ${path}`)
      if (path === '/session') return r.fulfill({ json: ADMIN })
      if (path === '/users') return r.fulfill({ json: users })
      if (path === '/invites' && method === 'GET')
        return r.fulfill({ json: invites })
      if (path === '/invites' || path === '/invites/i1/regenerate') {
        const url = `https://midden.test/invite#token-${++made}`
        const invite = {
          id: 'i1',
          label: path === '/invites' ? request.postDataJSON().label : '小红',
          created_at: new Date(now).toISOString(),
          expires_at: new Date(now + 7 * 86_400_000).toISOString(),
        }
        invites = [{ ...invite, url }]
        return r.fulfill({ json: { invite, url } })
      }
      if (path === '/invites/i1') {
        invites = []
        return r.fulfill({ status: 204 })
      }
      if (path === '/users/v1' && method === 'PATCH') {
        users = users.map((u) =>
          u.id === 'v1' ? { ...u, note: request.postDataJSON().note } : u,
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
      page.getByRole('link', { name: /^用户\s*查看者、邀请与备注/ }),
    ).toBeVisible()
    await page.getByRole('button', { name: '账号菜单' }).click()
    await expect(page.getByRole('menuitem')).toHaveText([
      '修改昵称',
      '管理员面板',
      '用户',
      '退出登录',
    ])
    await page.getByRole('menuitem', { name: '用户' }).click()
    await expect(page).toHaveURL(/\/settings\/admin\/users$/)
    const pane = page.getByRole('region', { name: '用户' })
    await expect(pane.locator('.user')).toHaveCount(2)
    await expect(pane.locator('.user').first()).toContainText('管理员')
    // The admin's 全站统计 has today's captures and updates.
    await page.goto('/')
    await expect(
      page.getByRole('region', { name: '全站统计' }).locator('dt'),
    ).toContainText(['今天采集', '今天更新'])
    await page.goto('/settings/admin/users')
    // The admin's own row is no button: nothing to do to them.
    await expect(pane.locator('button.user')).toHaveCount(1)
    await expect(pane.locator('button.user')).toContainText(
      '2个通行密钥、3个登录、1个令牌',
    )
    // Their nickname, the admin's note beside it.
    await expect(pane.locator('button.user .note')).toHaveText('同事')
    await expect(pane.locator('button.user')).toContainText('小明同事')

    // An invite: its label, then the link.
    await pane.getByRole('button', { name: '邀请' }).click()
    const form = page.getByRole('dialog', { name: '邀请' })
    await form.getByRole('textbox').fill('小红')
    await form.getByRole('button', { name: '生成链接' }).click()
    const link = page.getByRole('dialog', { name: '邀请小红' })
    await expect(link.getByRole('textbox')).toHaveValue(
      'https://midden.test/invite#token-1',
    )
    await expect(link).toContainText('7天内有效，只能用一次。')
    await expect(link).not.toContainText('只显示')
    await link.getByRole('button', { name: '复制链接' }).click()
    await expect(
      page.getByRole('status').filter({ hasText: '已复制链接' }),
    ).toBeVisible()
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe('https://midden.test/invite#token-1')
    await link.getByRole('button', { name: '关闭' }).click()
    await expect(link).toBeHidden()
    const invite = pane.locator('.invite')
    await expect(invite).toContainText('小红')
    await expect(invite).toContainText(/剩(6天23小时|7天)/)
    // Shown again, whenever asked.
    await invite.getByRole('button', { name: /^小红/ }).click()
    await expect(link.getByRole('textbox')).toHaveValue(
      'https://midden.test/invite#token-1',
    )
    // Made again, once confirmed: a new link.
    await link.getByRole('button', { name: '重新生成' }).click()
    const again = page.getByRole('dialog', { name: '重新生成链接？' })
    await expect(again).toContainText('原链接立即失效。')
    await again.getByRole('button', { name: '重新生成' }).click()
    await expect(link.getByRole('textbox')).toHaveValue(
      'https://midden.test/invite#token-2',
    )
    await link.getByRole('button', { name: '复制链接' }).click()
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe('https://midden.test/invite#token-2')
    await link.getByRole('button', { name: '关闭' }).click()
    await invite.getByRole('button', { name: /^小红/ }).click()
    await expect(link.getByRole('textbox')).toHaveValue(
      'https://midden.test/invite#token-2',
    )
    await link.getByRole('button', { name: '关闭' }).click()
    await invite.getByRole('button', { name: '撤销邀请小红' }).click()
    const revokeInvite = page.getByRole('dialog', { name: '撤销邀请小红？' })
    await revokeInvite.getByRole('button', { name: '撤销邀请' }).click()
    await expect(invite).toHaveCount(0)

    // 备注: the admin's note; the nickname stays theirs.
    await pane.locator('button.user').click()
    await expect(page.getByRole('menuitem', { name: '改名' })).toHaveCount(0)
    await page.getByRole('menuitem', { name: '备注' }).click()
    const note = page.getByRole('dialog', { name: '备注' })
    await expect(note.getByRole('textbox')).toHaveValue('同事')
    await note.getByRole('textbox').fill('大学同学')
    await note.getByRole('button', { name: '保存' }).click()
    await expect(pane.locator('button.user .note')).toHaveText('大学同学')
    await expect(pane.locator('button.user')).toContainText('小明')

    // 撤销, saying what it takes.
    await pane.locator('button.user').click()
    await page.getByRole('menuitem', { name: '撤销' }).click()
    const revoke = page.getByRole('dialog', { name: '撤销小明？' })
    await expect(revoke).toContainText('将删除2个通行密钥、3个登录、1个令牌。')
    await revoke.getByRole('button', { name: '撤销', exact: true }).click()
    await expect(pane.locator('button.user')).toContainText('已撤销')
    await expect(pane.locator('.user.revoked')).toHaveCount(1)

    // 删除 a revoked user.
    await pane.locator('button.user').click()
    await expect(page.getByRole('menuitem', { name: '撤销' })).toHaveCount(0)
    await page.getByRole('menuitem', { name: '删除' }).click()
    const remove = page.getByRole('dialog', { name: '删除小明？' })
    await expect(remove).toContainText('将删除这个用户和')
    await remove.getByRole('button', { name: '删除', exact: true }).click()
    await expect(pane.locator('.user')).toHaveCount(1)
    expect(sent).toEqual([
      'POST /invites',
      'POST /invites/i1/regenerate',
      'DELETE /invites/i1',
      'PATCH /users/v1',
      'POST /users/v1/revoke',
      'DELETE /users/v1',
    ])
  })

  test('without a clipboard, the link is selected to copy by hand', async ({
    page,
  }) => {
    // As on plain http and in some web views.
    await page.addInitScript(() => {
      delete (Navigator.prototype as { clipboard?: unknown }).clipboard
    })
    await mockDesktop(page)
    await page.route('**/v1/**', (r) => {
      const path = new URL(r.request().url()).pathname.replace(/^\/v1/, '')
      if (path === '/session') return r.fulfill({ json: ADMIN })
      if (path === '/users') return r.fulfill({ json: [] })
      if (path === '/invites')
        return r.fulfill({
          json: [
            {
              id: 'i1',
              label: '小红',
              created_at: new Date().toISOString(),
              expires_at: new Date(Date.now() + 86_400_000).toISOString(),
              url: 'https://midden.test/invite#kept',
            },
          ],
        })
      return r.fallback()
    })
    await page.goto('/settings/admin/users')
    await page.locator('.invite').getByRole('button', { name: /^小红/ }).click()
    const link = page.getByRole('dialog', { name: '邀请小红' })
    await link.getByRole('button', { name: '复制链接' }).click()
    await expect(
      page.getByRole('status').filter({ hasText: '请手动复制链接' }),
    ).toBeVisible()
    const field = link.getByRole('textbox')
    await expect
      .poll(() =>
        field.evaluate((input: HTMLInputElement) => [
          input.selectionStart,
          input.selectionEnd,
        ]),
      )
      .toEqual([0, 'https://midden.test/invite#kept'.length])
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
  const checked: object[] = []
  const options: object[] = []
  const joined: Record<string, unknown>[] = []
  await page.route('**/v1/**', (r) => {
    const request = r.request()
    const path = new URL(request.url()).pathname
    if (path === '/v1/session')
      return session
        ? r.fulfill({ json: VIEWER })
        : r.fulfill({ status: 401, json: { error: '需要登录' } })
    if (path === '/v1/auth/invite/check') {
      checked.push(request.postDataJSON())
      return r.fulfill({ status: 204 })
    }
    if (path === '/v1/auth/invite/options') {
      const body = request.postDataJSON()
      options.push(body)
      return r.fulfill({
        json: {
          rp: { name: 'Midden', id: 'localhost' },
          user: {
            id: Buffer.from('viewer-handle').toString('base64url'),
            name: body.name,
            displayName: body.name,
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
  // Their own nickname, from nothing: the invite's label is the admin's.
  await expect(page.getByLabel('昵称')).toHaveValue('')
  await expect(
    page.getByRole('button', { name: '创建通行密钥' }),
  ).toBeDisabled()
  await expect(page.getByLabel('通行密钥名称')).toHaveValue(/localhost/)
  await page.getByLabel('昵称').fill('小红红')
  await page.getByRole('button', { name: '创建通行密钥' }).click()
  await expect(page.locator('h1')).toHaveText('收藏库')
  await expect(page).toHaveURL(APP)
  expect(checked).toEqual([{ token: TOKEN }])
  expect(options).toEqual([{ token: TOKEN, name: '小红红' }])
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
    new URL(r.request().url()).pathname === '/v1/auth/invite/check'
      ? r.fulfill({ status: 403, json: { error: '邀请链接已失效' } })
      : r.fulfill({ status: 401, json: { error: '需要登录' } }),
  )
  await page.goto(`${APP}invite#${TOKEN}`)
  await expect(page.getByRole('alert')).toHaveText('邀请链接已失效')
  await expect(page.getByRole('button', { name: '创建通行密钥' })).toHaveCount(
    0,
  )
})
