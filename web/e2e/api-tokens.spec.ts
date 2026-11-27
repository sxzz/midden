import { expect, test, type Page } from './test'

const DAY = 24 * 3_600_000
const days = (counts: Record<number, number> = {}) =>
  Array.from({ length: 30 }, (_, i) => ({
    day: new Date(Date.now() - (29 - i) * DAY).toISOString().slice(0, 10),
    count: counts[i] ?? 0,
  }))

interface Token {
  id: string
  label: string
  permission: 'ro' | 'rw'
  created_at: string
  expires_at: string | null
  expired: boolean
  last_used_at: string | null
  usage: {
    today: number
    total: number
    days: { day: string; count: number }[]
  }
}

const research: Token = {
  id: 't1',
  label: '研究',
  permission: 'ro',
  created_at: '2026-11-01T08:00:00.000Z',
  expires_at: new Date(Date.now() + 6 * DAY + 3_600_000).toISOString(),
  expired: false,
  last_used_at: '2026-11-25T08:00:00.000Z',
  usage: { today: 2, total: 5, days: days({ 27: 3, 29: 2 }) },
}

/** The API as far as 设置 needs it, keeping the tokens it was told of. */
async function mock(page: Page) {
  const tokens: Token[] = [structuredClone(research)]
  const sent: { method: string; path: string; body?: unknown }[] = []
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (r) => {
    const request = r.request()
    const path = new URL(request.url()).pathname
    const method = request.method()
    const body = request.postData() ? request.postDataJSON() : undefined
    if (path.startsWith('/v1/tokens')) sent.push({ method, path, body })
    if (path === '/v1/session') return r.fulfill({ status: 204 })
    if (path === '/v1/tokens' && method === 'GET')
      return r.fulfill({ json: tokens })
    if (path === '/v1/tokens' && method === 'POST') {
      const token: Token = {
        id: 't2',
        label: body.label,
        permission: body.permission,
        created_at: new Date().toISOString(),
        expires_at: body.expires_at,
        expired: false,
        last_used_at: null,
        usage: { today: 0, total: 0, days: days() },
      }
      tokens.push(token)
      return r.fulfill({ json: { token, secret: 'mdn_rw_first-secret' } })
    }
    const one = tokens.find((t) => path.startsWith(`/v1/tokens/${t.id}`))
    if (one && path.endsWith('/usage'))
      return r.fulfill({
        json: {
          days: one.usage.days,
          endpoints: [
            { endpoint: 'GET /agent/v1/posts', count: 4 },
            { endpoint: 'GET /agent/v1/whoami', count: 1 },
          ],
        },
      })
    if (one && path.endsWith('/roll'))
      return r.fulfill({ json: { token: one, secret: 'mdn_ro_rolled-secret' } })
    if (one && method === 'PATCH') {
      Object.assign(one, body)
      return r.fulfill({ json: one })
    }
    if (one && method === 'DELETE') {
      tokens.splice(tokens.indexOf(one), 1)
      return r.fulfill({ status: 204 })
    }
    if (path === '/v1/passkeys') return r.fulfill({ json: [] })
    return r.fulfill({ json: { items: [] } })
  })
  return sent
}

const row = (page: Page, label: string) =>
  page.getByRole('button', { name: new RegExp(`^${label}，`) })
const sheet = (page: Page) => page.locator('dialog[open]')

test('lists tokens with their expiry and use, and makes one shown once', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const sent = await mock(page)
  await page.goto('/settings/tokens')
  const listed = row(page, '研究')
  await expect(listed).toContainText('只读')
  await expect(listed).toContainText('过期 · 剩6天')
  await expect(listed).toContainText('上次使用')
  await expect(listed).toContainText('30天5次')
  await expect(listed.getByRole('img')).toHaveAttribute(
    'aria-label',
    '最近30天5次',
  )

  await page.getByRole('button', { name: '创建令牌' }).click()
  await expect(sheet(page)).toContainText('创建令牌')
  await sheet(page).getByPlaceholder('名称').fill('同步')
  await sheet(page).getByText('读写').click()
  const before = Date.now()
  await sheet(page).getByRole('button', { name: '1天' }).click()
  await sheet(page).getByRole('button', { name: '创建', exact: true }).click()

  await expect(sheet(page)).toContainText('已创建 同步')
  await expect(sheet(page)).toContainText('令牌只显示这一次。')
  await expect(sheet(page).getByRole('textbox', { name: '令牌' })).toHaveValue(
    'mdn_rw_first-secret',
  )
  await sheet(page).getByRole('button', { name: '复制令牌' }).click()
  await expect(page.getByText('已复制令牌')).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('mdn_rw_first-secret')
  // What an agent needs in one paste; the API is this origin here (no
  // VITE_API_URL), the guide is the web app's.
  const origin = new URL(page.url()).origin
  const handoff = [
    `说明：${origin}/agent.md`,
    `API地址：${origin}`,
    '令牌：mdn_rw_first-secret',
  ].join('\n')
  await expect(
    sheet(page).getByRole('textbox', { name: '给AI agent' }),
  ).toHaveValue(handoff)
  await sheet(page).getByRole('button', { name: '复制给AI agent' }).click()
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(handoff)
  await sheet(page).getByRole('button', { name: '完成' }).click()
  await expect(sheet(page)).toHaveCount(0)

  const made = sent.find((s) => s.method === 'POST')!
  const body = made.body as {
    label: string
    permission: string
    expires_at: string
  }
  expect(body.label).toBe('同步')
  expect(body.permission).toBe('rw')
  // The picker holds minutes; a day from when it was pressed.
  const at = Date.parse(body.expires_at)
  expect(at).toBeGreaterThan(before + DAY - 120_000)
  expect(at).toBeLessThan(Date.now() + DAY)
  await expect(row(page, '同步')).toContainText('读写')
  await expect(row(page, '同步')).toContainText('未使用')
})

test('edits, rolls and revokes a token', async ({ page }) => {
  const sent = await mock(page)
  await page.goto('/settings/tokens')
  await row(page, '研究').click()
  await expect(sheet(page)).toContainText('最近30天5次')
  await expect(sheet(page)).toContainText('GET /agent/v1/posts')
  await expect(sheet(page)).toContainText('只读')

  // Never expiring, under a new name; the secret stays.
  await sheet(page).getByRole('button', { name: '编辑名称和过期时间' }).click()
  await expect(sheet(page)).toContainText('编辑令牌')
  await expect(sheet(page).getByText('权限')).toHaveCount(0)
  await sheet(page).getByPlaceholder('名称').fill('研究 2')
  await sheet(page).getByLabel('永不过期').check()
  await expect(sheet(page).getByLabel('过期时间')).toBeDisabled()
  await sheet(page).getByRole('button', { name: '保存' }).click()
  await expect(row(page, '研究 2')).toContainText('永不过期')
  expect(sent.find((s) => s.method === 'PATCH')!.body).toEqual({
    label: '研究 2',
    expires_at: null,
  })

  // An expiry in the past is refused before it is sent.
  await row(page, '研究 2').click()
  await sheet(page).getByRole('button', { name: '编辑名称和过期时间' }).click()
  await sheet(page).getByLabel('永不过期').uncheck()
  await sheet(page).getByLabel('过期时间').fill('2020-01-01T00:00')
  await sheet(page).getByRole('button', { name: '保存' }).click()
  await expect(sheet(page)).toContainText('过期时间必须晚于现在')
  await sheet(page).getByRole('button', { name: '取消' }).click()

  await row(page, '研究 2').click()
  await sheet(page).getByRole('button', { name: '轮换令牌' }).click()
  await expect(sheet(page)).toContainText('旧令牌立即失效')
  await sheet(page).getByRole('button', { name: '轮换令牌' }).click()
  await expect(sheet(page)).toContainText('已轮换 研究 2')
  await expect(sheet(page).getByRole('textbox', { name: '令牌' })).toHaveValue(
    'mdn_ro_rolled-secret',
  )
  await sheet(page).getByRole('button', { name: '完成' }).click()

  await row(page, '研究 2').click()
  await sheet(page).getByRole('button', { name: '撤销令牌' }).click()
  await expect(sheet(page)).toContainText('撤销 研究 2？')
  await sheet(page).getByRole('button', { name: '撤销令牌' }).click()
  await expect(page.getByText('已撤销 研究 2')).toBeVisible()
  await expect(row(page, '研究 2')).toHaveCount(0)
  expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual(
    expect.arrayContaining(['POST /v1/tokens/t1/roll', 'DELETE /v1/tokens/t1']),
  )
})
