import { expect, test } from '@playwright/test'

const main = '33333333-3333-4333-8333-333333333333'

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
