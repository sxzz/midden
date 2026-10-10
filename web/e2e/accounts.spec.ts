import { expect, test } from '@playwright/test'

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
    return r.fulfill({ json: path === '/v1/accounts' ? state : { items: [] } })
  })
  await page.goto('/app/')
  await page.getByRole('link', { name: '采集账号' }).click()
  const form = page.locator('section').filter({
    has: page.getByRole('heading', {
      name: '添加 Instagram 账号',
      exact: true,
    }),
  })
  await expect(
    page.getByText('Instagram 需要添加并选择自己的账号凭据后才能采集。'),
  ).toBeVisible()
  await expect(form).toContainText('sessionid')
  await form.getByLabel('凭据').fill('fixture-cookie')
  await form.getByRole('button', { name: '验证并添加' }).click()
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
    page.getByText('删除后，需要选择其他账号或重新添加自己的凭据才能采集。'),
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
          json: { error: 'invalid credentials' },
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
    if (path === '/v1/usage')
      return r.fulfill({
        json: { used_bytes: 0, reserved_bytes: 0, limit_bytes: 1000 },
      })
    return r.fulfill({ json: { items: [] } })
  })
  await page.goto('/app/')
  await page.getByRole('link', { name: '采集账号' }).click()
  await expect(page.locator('h1')).toHaveText('采集账号')
  // Same build version as the bot's /start: a commit, or dev outside git.
  const version = page.getByRole('link', { name: /^[0-9a-f]{7}(-dirty)?$/ })
  await expect(version).toHaveAttribute(
    'href',
    /^https:\/\/github\.com\/sxzz\/midden\/commit\/[0-9a-f]{40}$/,
  )
  await expect(page.getByText('添加 X 账号')).toBeVisible()
  await expect(page.getByText('Base64 Cookie')).toBeVisible()

  const credential = page.getByLabel('凭据')
  const submit = page.getByRole('button', { name: '验证并添加' })
  await expect(submit).toBeDisabled()
  await credential.fill('expired')
  await submit.click()
  await expect(page.getByRole('alert')).toHaveText(/凭据无效/)

  await credential.fill('  opaque-cookie  ')
  await page.getByLabel('名称（可选）').fill('主号')
  await submit.click()
  await expect(page.getByText('已添加并选择 @synthetic · 主号。')).toBeVisible()
  await expect(credential).toHaveValue('')
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

  await page.getByRole('button', { name: '返回' }).click()
  await expect(page.locator('h1')).toHaveText('我的收藏')
})
