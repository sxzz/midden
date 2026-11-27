import { expect, test } from './test'

const view = (limits: unknown[]) => ({
  control: { paused: false, types: [] },
  pausable: ['upload', 'raw-upload'],
  backlog: [{ type: 'capture', waiting: 3, running: 0, paused: 0 }],
  rate_limits: limits,
  worker: null,
  web: null,
})

test('后台任务 lists rate limits and ends one early', async ({ page }) => {
  const until = new Date(Date.now() + 12 * 60_000 + 30_000)
  const limit = {
    scope: 'x:session:a:UserTweets',
    platform: 'x',
    account: '@owner',
    endpoint: 'UserTweets',
    until: until.toISOString(),
    since: new Date().toISOString(),
    hits: 2,
    reason: 'HTTP 429',
    waiting: 3,
  }
  let limits: unknown[] = [limit]
  const cleared: unknown[] = []
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (r) => {
    const request = r.request()
    const path = new URL(request.url()).pathname
    if (path === '/v1/session') return r.fulfill({ json: {} })
    if (path === '/v1/queue/rate-limits/clear') {
      cleared.push(request.postDataJSON())
      limits = []
      return r.fulfill({ json: view(limits) })
    }
    if (path === '/v1/queue') return r.fulfill({ json: view(limits) })
    return r.fulfill({ json: { items: [] } })
  })
  await page.goto('/app/settings/admin/jobs')
  const row = page.getByRole('button', { name: /X @owner · UserTweets/ })
  const time = `${until.getHours()}:${String(until.getMinutes()).padStart(2, '0')}`
  await expect(row).toContainText(`${time} 恢复，还有 13 分钟 · 等待 3`)
  await expect(row).toContainText('解除')
  await row.click()
  await expect(row).toHaveCount(0)
  expect(cleared).toEqual([{ scope: 'x:session:a:UserTweets' }])
})

test('后台任务 lists the slow queries, newest first', async ({ page }) => {
  const at = new Date()
  const slow = [
    {
      id: 2,
      at: at.toISOString(),
      route: 'GET /agent/v1/posts',
      query: '{"q":"#猫 lang:ja","sort":"updated"}',
      sql: 'SELECT …',
      params: '[]',
      ms: 1234,
      rows: 21,
    },
    {
      id: 1,
      at: new Date(+at - 60_000).toISOString(),
      route: 'GET /v1/collections',
      query: '',
      sql: 'SELECT count(*) FROM catalog',
      params: '[]',
      ms: 310,
      rows: 1,
    },
  ]
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (r) => {
    const path = new URL(r.request().url()).pathname
    if (path === '/v1/session') return r.fulfill({ json: {} })
    if (path === '/v1/queue') return r.fulfill({ json: view([]) })
    if (path === '/v1/queue/slow-queries')
      return r.fulfill({ json: { items: slow } })
    return r.fulfill({ json: { items: [] } })
  })
  await page.goto('/app/settings/admin/jobs')
  await expect(page.getByText('慢查询（300 ms 以上）')).toBeVisible()
  const first = page.locator('.slow').first()
  await expect(first).toContainText('GET /agent/v1/posts')
  await expect(first).toContainText('1,234 ms · 21 行')
  await expect(first).toContainText('{"q":"#猫 lang:ja","sort":"updated"}')
  // Without a query, its SQL.
  await expect(page.locator('.slow').nth(1)).toContainText(
    'SELECT count(*) FROM catalog',
  )
})
