import { expect, test, type Page } from './test'

const DAY = 24 * 3_600_000

interface Session {
  id: string
  current: boolean
  method: 'passkey' | 'telegram' | null
  origin: string | null
  device: string | null
  created_at: string
  last_used_at: string
  expires_at: string
}

const session = (
  id: string,
  fields: Partial<Session>,
  usedDaysAgo = 0,
): Session => ({
  id,
  current: false,
  method: 'passkey',
  origin: 'https://midden.test',
  device: null,
  created_at: '2026-11-01T08:00:00.000Z',
  last_used_at: new Date(Date.now() - usedDaysAgo * DAY).toISOString(),
  expires_at: new Date(Date.now() + 30 * DAY).toISOString(),
  ...fields,
})

/** The API as far as 已登录的设备 needs it, keeping what was revoked. */
async function mock(page: Page, { slow = false } = {}) {
  let sessions: Session[] = [
    session('here', { current: true, device: 'Chrome · macOS' }),
    session('phone', { method: 'telegram', device: 'Telegram · iOS' }, 3),
    session('old', { method: null, origin: null }, 1),
  ]
  const sent: string[] = []
  let release = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', async (r) => {
    const request = r.request()
    const path = new URL(request.url()).pathname
    const method = request.method()
    if (path.startsWith('/v1/sessions')) sent.push(`${method} ${path}`)
    if (path === '/v1/session') return r.fulfill({ status: 204 })
    if (path === '/v1/sessions' && method === 'GET') {
      if (slow) await held
      return r.fulfill({ json: sessions })
    }
    if (path === '/v1/sessions/revoke-others' && method === 'POST') {
      const revoked = sessions.filter((s) => !s.current).length
      sessions = sessions.filter((s) => s.current)
      return r.fulfill({ json: { revoked } })
    }
    if (path.startsWith('/v1/sessions/') && method === 'DELETE') {
      sessions = sessions.filter((s) => `/v1/sessions/${s.id}` !== path)
      return r.fulfill({ status: 204 })
    }
    if (path === '/v1/passkeys') return r.fulfill({ json: [] })
    return r.fulfill({ json: { items: [] } })
  })
  return { sent, release }
}

const sheet = (page: Page) => page.locator('dialog[open]')
const rows = (page: Page) => page.locator('.session')

test('lists the signed-in devices, this one marked, and signs others out', async ({
  page,
}) => {
  const { sent } = await mock(page)
  await page.goto('/settings/passkeys')
  await page.getByRole('link', { name: /已登录的设备/ }).click()
  await expect(page).toHaveURL(/\/settings\/passkeys\/sessions$/)
  await expect(rows(page)).toHaveCount(3)
  await page.screenshot({ path: 'test-results/sessions.png' })

  const here = rows(page).nth(0)
  await expect(here).toContainText('Chrome · macOS')
  await expect(here).toContainText('当前设备')
  await expect(here).toContainText('midden.test · 通行密钥 · 登录于')
  await expect(here).not.toContainText('最近使用')
  await expect(here.getByRole('button')).toHaveCount(0)
  await expect(rows(page).nth(1)).toContainText('Telegram · iOS')
  await expect(rows(page).nth(1)).toContainText(
    'midden.test · Telegram Mini App · 最近使用：3 天前',
  )
  await expect(rows(page).nth(2)).toContainText('未知设备')
  await expect(rows(page).nth(2)).toContainText('最近使用：昨天')
  await expect(page.getByText('最近使用的时间精确到天。')).toBeVisible()

  // One, after confirming.
  await page.getByRole('button', { name: '退出 Telegram · iOS' }).click()
  await expect(sheet(page)).toContainText('退出 Telegram · iOS？')
  expect(sent).not.toContain('DELETE /v1/sessions/phone')
  await sheet(page).getByRole('button', { name: '退出', exact: true }).click()
  await expect(page.getByText('已退出 Telegram · iOS')).toBeVisible()
  await expect(rows(page)).toHaveCount(2)
  expect(sent).toContain('DELETE /v1/sessions/phone')

  // Every other one.
  await page.getByRole('button', { name: '退出其他所有设备' }).click()
  await expect(sheet(page)).toContainText('退出其他 1 个设备？')
  await sheet(page).getByRole('button', { name: '退出其他所有设备' }).click()
  await expect(page.getByText('已退出其他所有设备')).toBeVisible()
  await expect(rows(page)).toHaveCount(1)
  await expect(rows(page)).toContainText('当前设备')
  await expect(
    page.getByRole('button', { name: '退出其他所有设备' }),
  ).toHaveCount(0)
  expect(sent).toContain('POST /v1/sessions/revoke-others')
})

test('holds the rows with a skeleton while reading', async ({ page }) => {
  const { release } = await mock(page, { slow: true })
  await page.goto('/settings/passkeys/sessions')
  const skeleton = page.getByRole('status', { name: '正在读取已登录的设备' })
  await expect(skeleton).toBeVisible()
  release()
  await expect(skeleton).toHaveCount(0)
  await expect(rows(page)).toHaveCount(3)
})
