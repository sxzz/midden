import { mockDesktop } from './desktop-mock'
import { expect, test, type Page } from './test'

// Loading shows as a skeleton of the page, once; reading again keeps the
// page as it is.

const queue = (waiting: number) => ({
  control: { paused: false, types: [] },
  pausable: ['thumbnail', 'upload', 'raw-upload'],
  backlog: [{ type: 'capture', waiting, running: 1, paused: 0 }],
  rate_limits: [],
  worker: null,
  web: null,
})
const START = new Date('2026-11-27T10:00:00Z')
const height = (page: Page) =>
  page.evaluate(() => document.querySelector('main.page')!.scrollHeight)

test('后台任务: a skeleton first, then the same page on every read', async ({
  page,
}) => {
  // Time stands still but for the steps the test takes.
  await page.clock.install({ time: START })
  await page.clock.pauseAt(new Date(START.getTime() + 60_000))
  await mockDesktop(page)
  let reads = 0
  let release = () => {}
  const first = new Promise<void>((resolve) => (release = resolve))
  await page.route('**/v1/queue', async (r) => {
    reads++
    // The first answer is slow, the later ones are not.
    if (reads === 1) await first
    await r.fulfill({ json: queue(reads) })
  })
  await page.goto('/app/settings/admin/jobs')
  const skeleton = page.getByRole('status', { name: '正在读取后台任务' })
  await expect(skeleton).toBeVisible()
  await expect(page.getByText(/加载中/)).toHaveCount(0)
  // It holds the place it will fill, but shows only after a moment.
  await expect(skeleton).toHaveCSS('animation-delay', '0.18s')
  release()
  await expect(page.getByText('暂停全部')).toBeVisible()
  await expect(page.getByText('等待 1 · 进行中 1')).toBeVisible()
  await expect(page.getByRole('status', { name: /^正在读取/ })).toHaveCount(0)

  const before = await height(page)
  // Read again every 5 seconds: the numbers change in place.
  for (const n of [2, 3, 4]) {
    await page.clock.runFor(5000)
    await expect(page.getByText(`等待 ${n} · 进行中 1`)).toBeVisible()
    await expect(page.getByRole('status', { name: /^正在读取/ })).toHaveCount(0)
    await expect(page.getByText(/加载中/)).toHaveCount(0)
    expect(Math.abs((await height(page)) - before)).toBeLessThanOrEqual(2)
  }
})

test('后台任务: a failed read keeps the last answer, under why', async ({
  page,
}) => {
  await page.clock.install({ time: START })
  await page.clock.pauseAt(new Date(START.getTime() + 60_000))
  await mockDesktop(page)
  let reads = 0
  await page.route('**/v1/queue', (r) => {
    reads++
    return reads === 2
      ? r.fulfill({ status: 503, json: { error: '服务暂时不可用' } })
      : r.fulfill({ json: queue(reads) })
  })
  await page.goto('/app/settings/admin/jobs')
  await expect(page.getByText('等待 1 · 进行中 1')).toBeVisible()
  await page.clock.runFor(5000)
  await expect(page.getByRole('alert')).toHaveText('服务暂时不可用')
  await expect(page.getByText('等待 1 · 进行中 1')).toBeVisible()
  await page.clock.runFor(5000)
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByText('等待 3 · 进行中 1')).toBeVisible()
})

test('lists read for the first time show their skeleton, not words', async ({
  page,
}) => {
  await mockDesktop(page)
  let release = () => {}
  const answered = new Promise<void>((resolve) => (release = resolve))
  await page.route('**/v1/passkeys', async (r) => {
    await answered
    await r.fulfill({ json: [] })
  })
  await page.goto('/app/settings/passkeys')
  await expect(
    page.getByRole('status', { name: '正在读取通行密钥' }),
  ).toBeVisible()
  await expect(page.getByText(/加载中/)).toHaveCount(0)
  release()
  await expect(
    page.getByRole('status', { name: '正在读取通行密钥' }),
  ).toHaveCount(0)
})
