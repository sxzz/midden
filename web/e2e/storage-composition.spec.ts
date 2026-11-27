import { expect, test } from './test'

const GiB = 2 ** 30
const report = (job: unknown, computedAt: string) => ({
  r2: null,
  cost: null,
  local: {
    database: {
      bytes: GiB,
      page_size: 4096,
      pages: 1,
      freelist_pages: 0,
      wal_bytes: 0,
    },
    thumbnails: { count: 0, bytes: 0, local_count: 0, local_bytes: 0 },
    deploy_backups: { files: 0, bytes: 0 },
    disk: { free_bytes: 100 * GiB, total_bytes: 400 * GiB },
  },
  composition: {
    computed_at: computedAt,
    seconds: 2.5,
    total_bytes: GiB,
    items: [
      { name: 'revisions', type: 'table', table: 'revisions', bytes: GiB },
    ],
    rest: { count: 0, bytes: 0 },
    media: { files: 1, bytes: 10 },
  },
  composition_job: job,
  history: [],
  alerts: { cost_usd: 5, free_disk_gb: 10, db_gb: 5, ops_percent: 80 },
})

test('存储用量 says when the database was counted and counts again', async ({
  page,
}) => {
  const hoursAgo = (n: number) =>
    new Date(Date.now() - n * 3_600_000).toISOString()
  let current = report(null, hoursAgo(3))
  let posts = 0
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (r) => {
    const request = r.request()
    const path = new URL(request.url()).pathname
    if (path === '/v1/session') return r.fulfill({ json: {} })
    if (path === '/v1/storage/composition' && request.method() === 'POST') {
      posts++
      current = report(
        { state: 'queued', at: new Date().toISOString() },
        hoursAgo(3),
      )
      // The worker answers a moment later.
      setTimeout(() => (current = report(null, new Date().toISOString())), 2500)
      return r.fulfill({ json: current.composition_job })
    }
    if (path === '/v1/storage') return r.fulfill({ json: current })
    if (path === '/v1/origins') return r.fulfill({ json: [] })
    return r.fulfill({ json: { items: [] } })
  })
  await page.goto('/#/settings/admin/storage')
  await expect(page.getByText(/统计于3小时前/)).toBeVisible()
  await page.getByRole('button', { name: '重新统计' }).click()
  await expect(page.getByRole('button', { name: '统计中…' })).toBeDisabled()
  await expect(page.getByText(/统计于不到1分钟前/)).toBeVisible()
  await expect(page.getByRole('button', { name: '重新统计' })).toBeEnabled()
  expect(posts).toBe(1)
})
