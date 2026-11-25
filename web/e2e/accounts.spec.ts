import { expect, test, type Page } from './test'

const main = '33333333-3333-4333-8333-333333333333'

test('Instagram and X choose their accounts independently', async ({
  page,
}) => {
  const instagram = '44444444-4444-4444-8444-444444444444'
  let state = {
    platforms: [
      {
        id: 'x',
        name: 'X',
        public: true,
        can_add: true,
        selected_account_id: main,
        help: 'X Cookie',
      },
      {
        id: 'instagram',
        name: 'Instagram',
        public: false,
        can_add: true,
        selected_account_id: '',
        help: 'Base64 Cookie，需包含 sessionid。',
      },
    ],
    accounts: [
      {
        id: main,
        platform: 'x',
        username: 'x_fixture',
        name: 'X 主号',
        state: 'ready',
        selected: true,
      },
    ],
  }
  const selected: unknown[] = []
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (r) => {
    const request = r.request()
    const path = new URL(request.url()).pathname
    if (path === '/v1/accounts' && request.method() === 'POST') {
      const body = request.postDataJSON()
      expect(body).toEqual({
        platform: 'instagram',
        credential: 'fixture-cookie',
        name: '',
      })
      const account = {
        id: instagram,
        platform: 'instagram',
        username: 'fixture.name',
        name: '',
        state: 'ready',
        selected: true,
      }
      state.accounts.push(account)
      state.platforms[1]!.selected_account_id = instagram
      return r.fulfill({ status: 201, json: account })
    }
    if (path === '/v1/accounts/selection') {
      const body = request.postDataJSON()
      selected.push(body)
      state = {
        platforms: state.platforms.map((p) =>
          p.id === body.platform
            ? { ...p, selected_account_id: body.account_id }
            : p,
        ),
        accounts: state.accounts.map((a) =>
          a.platform === body.platform
            ? { ...a, selected: a.id === body.account_id }
            : a,
        ),
      }
      return r.fulfill({ json: state })
    }
    if (path === '/v1/passkeys') return r.fulfill({ json: [] })
    if (path === '/v1/origins')
      return r.fulfill({
        json: [{ origin: 'https://midden.test', passkeys: 0 }],
      })
    return r.fulfill({ json: path === '/v1/accounts' ? state : { items: [] } })
  })
  await page.goto('/app/')
  await openSettings(page, '采集账号')
  await expect(
    page.getByText('Instagram 需要先添加并选择一个账号才能采集。'),
  ).toBeVisible()
  // Adding is a sheet opened from the platform's own source list.
  await page
    .locator('section')
    .filter({
      has: page.getByRole('heading', {
        name: 'Instagram 采集来源',
        exact: true,
      }),
    })
    .getByRole('button', { name: '添加账号' })
    .click()
  const form = page.getByRole('dialog', { name: '添加 Instagram 账号' })
  await expect(form).toContainText('sessionid')
  await form.getByLabel('凭据').fill('fixture-cookie')
  await form.getByRole('button', { name: '验证并添加' }).click()
  await expect(form).toBeHidden()
  const x = page.getByRole('button', {
    name: '@x_fixture · X 主号',
    exact: true,
  })
  const ig = page.getByRole('button', { name: '@fixture.name', exact: true })
  await expect(ig).toHaveAttribute('aria-pressed', 'true')
  await expect(x).toHaveAttribute('aria-pressed', 'true')
  const source = page.locator('section').filter({
    has: page.getByRole('heading', {
      name: 'Instagram 采集来源',
      exact: true,
    }),
  })
  await expect(
    source.getByRole('button', { name: '公共来源', exact: true }),
  ).toHaveCount(0)
  await expect(x).toHaveAttribute('aria-pressed', 'true')
  await ig.click()
  await expect(ig).toHaveAttribute('aria-pressed', 'true')
  expect(selected.at(-1)).toEqual({
    platform: 'instagram',
    account_id: instagram,
  })
  await page
    .getByRole('button', { name: '删除 @fixture.name', exact: true })
    .click()
  await expect(
    page.getByText('删除后，需要选择其他账号或重新添加才能采集。'),
  ).toBeVisible()
})

test('adds, selects and deletes an X account', async ({ page }) => {
  const platform: Record<string, unknown> = {
    id: 'x',
    name: 'X',
    help: 'Base64 Cookie，需包含 auth_token 和 ct0。',
    public: true,
    can_add: true,
  }
  const accounts: Record<string, unknown>[] = []
  let state = { platforms: [platform], accounts }
  const posted: unknown[] = []
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (r) => {
    const request = r.request()
    const path = new URL(request.url()).pathname
    if (path === '/v1/accounts' && request.method() === 'POST') {
      const body = request.postDataJSON()
      posted.push(body)
      if (body.credential === 'expired')
        return r.fulfill({
          status: 400,
          json: { error: '凭据无效或已过期' },
        })
      const account = {
        id: main,
        name: body.name || '采集账号',
        username: 'synthetic',
        state: 'ready',
        platform: 'x',
        selected: true,
      }
      state = {
        platforms: [{ ...state.platforms[0], selected_account_id: main }],
        accounts: [account],
      }
      return r.fulfill({ status: 201, json: account })
    }
    if (path === '/v1/accounts/selection') {
      const { account_id } = request.postDataJSON()
      state = {
        platforms: [
          { ...state.platforms[0], selected_account_id: account_id || '' },
        ],
        accounts: state.accounts.map((a) => ({
          ...a,
          selected: a.id === account_id,
        })),
      }
      return r.fulfill({ json: state })
    }
    if (path === `/v1/accounts/${main}`) {
      state = {
        platforms: [{ ...state.platforms[0], selected_account_id: '' }],
        accounts: [],
      }
      return r.fulfill({ status: 204 })
    }
    if (path === '/v1/accounts') return r.fulfill({ json: state })
    if (path === '/v1/passkeys') return r.fulfill({ json: [] })
    if (path === '/v1/origins')
      return r.fulfill({
        json: [{ origin: 'https://midden.test', passkeys: 0 }],
      })
    if (path === '/v1/usage')
      return r.fulfill({
        json: { used_bytes: 0 },
      })
    return r.fulfill({ json: { items: [] } })
  })
  await page.goto('/app/')
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name: '设置' })
    .click()
  await expect(page.locator('h1')).toHaveText('设置')
  // 关于: the same build version as the bot's /start, a commit or dev
  // outside git, and the source.
  const version = page.getByRole('link', { name: /^[0-9a-f]{7}(-dirty)?$/ })
  await expect(version).toHaveAttribute(
    'href',
    /^https:\/\/github\.com\/sxzz\/midden\/commit\/[0-9a-f]{40}$/,
  )
  await expect(page.getByRole('link', { name: /^源代码/ })).toHaveAttribute(
    'href',
    'https://github.com/sxzz/midden',
  )
  await expect(page.getByText('构建时间')).toBeVisible()
  await page.getByRole('link', { name: '采集账号' }).click()
  await expect(page.locator('h1')).toHaveText('采集账号')
  // The form stays out of the source list until asked for.
  await expect(page.getByLabel('凭据')).toBeHidden()
  await page.getByRole('button', { name: '添加账号' }).click()
  const sheet = page.getByRole('dialog', { name: '添加 X 账号' })
  await expect(sheet).toContainText('Base64 Cookie')

  const credential = sheet.getByLabel('凭据')
  const submit = sheet.getByRole('button', { name: '验证并添加' })
  await expect(submit).toBeDisabled()
  await credential.fill('expired')
  await submit.click()
  await expect(sheet.getByRole('alert')).toHaveText(/凭据无效/)

  await credential.fill('  opaque-cookie  ')
  await sheet.getByLabel('名称（可选）').fill('主号')
  await submit.click()
  await expect(page.getByText('已添加并选择 @synthetic · 主号。')).toBeVisible()
  await expect(sheet).toBeHidden()
  // Opening it again starts from an empty form.
  await page.getByRole('button', { name: '添加账号' }).click()
  await expect(credential).toHaveValue('')
  await sheet.getByRole('button', { name: '取消' }).click()
  expect(posted.at(-1)).toEqual({
    platform: 'x',
    credential: 'opaque-cookie',
    name: '主号',
  })
  const account = page.getByRole('button', {
    name: '@synthetic · 主号',
    exact: true,
  })
  await expect(account).toHaveAttribute('aria-pressed', 'true')

  await page.getByRole('button', { name: '公共来源' }).click()
  await expect(account).toHaveAttribute('aria-pressed', 'false')
  await account.click()
  await expect(account).toHaveAttribute('aria-pressed', 'true')

  await page.getByRole('button', { name: '删除 @synthetic · 主号' }).click()
  await page.getByRole('button', { name: '删除账号' }).click()
  await expect(account).toHaveCount(0)

  await page.getByRole('link', { name: '返回' }).click()
  await expect(page.locator('h1')).toHaveText('设置')
})

test('deleting everything shows what goes and needs the phrase typed', async ({
  page,
}) => {
  let deleted: unknown
  let listed = [
    {
      id: '11111111-1111-4111-8111-111111111111',
      url: 'https://example.test/post/1',
      text: '要删除的收藏',
      author_name: '作者',
      saved_at: '2026-09-29T10:00:00Z',
      observed_at: '2026-09-29T10:00:00Z',
      revision_id: 'r1',
      assets: [],
    },
  ]
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (r) => {
    const request = r.request()
    const path = new URL(request.url()).pathname
    if (path === '/v1/session') return r.fulfill({ json: {} })
    if (path === '/v1/passkeys') return r.fulfill({ json: [] })
    if (path === '/v1/origins')
      return r.fulfill({
        json: [{ origin: 'https://midden.test', passkeys: 0 }],
      })
    if (path === '/v1/accounts')
      return r.fulfill({ json: { platforms: [], accounts: [] } })
    if (path === '/v1/library')
      return r.fulfill({ json: { collections: 12, records: 30, running: 2 } })
    if (path === '/v1/library/delete-all') {
      deleted = request.postDataJSON()
      listed = []
      return r.fulfill({ json: { collections: 12, records: 30, running: 0 } })
    }
    if (path === '/v1/collections')
      return r.fulfill({ json: { items: listed } })
    if (path === '/v1/instance')
      return r.fulfill({ json: { dev: true, litestream: { enabled: false } } })
    return r.fulfill({ json: {} })
  })
  await page.goto('/app/')
  await expect(page.getByText('要删除的收藏')).toBeVisible()
  await openSettings(page, '管理员面板')
  await page
    .getByRole('button', { name: '删除全部收藏和采集记录', exact: true })
    .click()
  const sheet = page.getByRole('dialog', { name: '删除全部收藏和采集记录？' })
  await expect(sheet).toContainText(
    '12 条收藏、30 条采集记录（2 条进行中），无法恢复。',
  )
  const confirm = sheet.getByRole('button', { name: '永久删除' })
  await expect(confirm).toBeDisabled()
  await sheet.getByLabel('输入「删除全部」以确认').fill('删除')
  await expect(confirm).toBeDisabled()
  // Cancelling forgets what was typed.
  await sheet.getByRole('button', { name: '取消' }).click()
  await page
    .getByRole('button', { name: '删除全部收藏和采集记录', exact: true })
    .click()
  await expect(sheet.getByLabel('输入「删除全部」以确认')).toHaveValue('')
  expect(deleted).toBeUndefined()
  await sheet.getByLabel('输入「删除全部」以确认').fill('删除全部')
  await confirm.click()
  await expect(
    page.getByText('已删除 12 条收藏和 30 条采集记录。'),
  ).toBeVisible()
  expect(deleted).toEqual({ confirm: 'delete all' })
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name: '探索' })
    .click()
  await expect(page.locator('h1')).toHaveText('我的收藏')
  await expect(page.locator('.row')).toHaveCount(0)
  await expect(page.getByText(/暂无/)).toHaveCount(0)
})

test('deleting everything is not offered outside development', async ({
  page,
}) => {
  let asked = false
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (r) => {
    const path = new URL(r.request().url()).pathname
    if (path === '/v1/session') return r.fulfill({ json: {} })
    if (path === '/v1/origins')
      return r.fulfill({
        json: [{ origin: 'https://midden.test', passkeys: 0 }],
      })
    if (path === '/v1/instance')
      return r.fulfill({ json: { dev: false, litestream: { enabled: false } } })
    if (path === '/v1/library/delete-all') asked = true
    return r.fulfill({ json: { items: [] } })
  })
  await page.goto('/app/#/settings/admin')
  await expect(page.locator('h1')).toHaveText('管理员面板')
  await expect(
    page.getByRole('heading', { name: '域名', exact: true }),
  ).toBeVisible()
  await expect(page.getByText('删除全部收藏和采集记录')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: '开发模式' })).toHaveCount(0)
  expect(asked).toBe(false)
})

/** 设置, through the bottom bar, then one of its pages. */
async function openSettings(page: Page, name: string) {
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name: '设置' })
    .click()
  await page.getByRole('link', { name, exact: true }).click()
  await expect(page.locator('h1')).toHaveText(name)
}
