import { expect, test, type Page } from '@playwright/test'
const first = '11111111-1111-4111-8111-111111111111'
const second = '22222222-2222-4222-8222-222222222222'
const asset = (id: string, mime = 'image/png', sensitive = false) => ({
  id,
  mime,
  sensitive,
  state: 'ready',
})
const item = (id: string, assets: ReturnType<typeof asset>[]) => ({
  id,
  assets,
  text: '正文不出现在相册',
  author_name: '作者',
  url: 'https://example.test/post',
  revision_id: 'r1',
  observed_at: '2026-09-30T10:00:00Z',
  saved_at: '2026-09-30T10:00:00Z',
  visibility: 'public',
})
async function setup(page: Page, paginated = false) {
  const queries: URLSearchParams[] = []
  const records = [
    item(first, [asset('one'), asset('video', 'video/mp4', true)]),
    item(second, [asset('two')]),
  ]
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (r) => {
    const u = new URL(r.request().url())
    if (u.pathname.startsWith('/v1/assets/'))
      return r.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#678"/></svg>',
      })
    if (u.pathname === '/v1/collections') {
      queries.push(u.searchParams)
      if (paginated && !u.searchParams.has('cursor'))
        return r.fulfill({
          json: { items: [item(first, [])], next_cursor: 'page2' },
        })
      return r.fulfill({ json: { items: records } })
    }
    const record = records.find((a) => u.pathname === `/v1/collections/${a.id}`)
    return r.fulfill({
      json:
        record ||
        (u.pathname === '/v1/usage'
          ? { used_bytes: 0, reserved_bytes: 0, limit_bytes: 1000 }
          : { items: [] }),
    })
  })
  return queries
}
test('album reuses loaded data and opens the currently previewed collection', async ({
  page,
}) => {
  const queries = await setup(page)
  await page.goto('/app/')
  await expect(page.locator('.row')).toHaveCount(2)
  await page.getByRole('button', { name: '相册', exact: true }).click()
  await expect(page).toHaveURL(/layout=album/)
  await expect(page.locator('.album button')).toHaveCount(3)
  expect(queries).toHaveLength(1)
  await expect(page.locator('.row')).toHaveCount(0)
  await page.locator('.album button').first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('1 / 3')).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await expect(dialog.getByText('2 / 3')).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await expect(dialog.getByText('3 / 3')).toBeVisible()
  await dialog.getByRole('button', { name: '打开收藏详情' }).click()
  await expect(page).toHaveURL(new RegExp(`/collection/${second}$`))
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden')
  await page.getByRole('button', { name: '返回', exact: true }).click()
  await expect(
    page.getByRole('button', { name: '相册', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.album button')).toHaveCount(3)
  expect(queries).toHaveLength(1)
  await page.screenshot({
    path: 'test-results/album-layout.png',
    fullPage: true,
  })
})
test('album keeps layout through filter changes and excludes other resource types', async ({
  page,
}) => {
  const queries = await setup(page)
  await page.goto('/app/#/?layout=album&media_type=video')
  await expect(page.locator('.album button')).toHaveCount(1)
  const tile = page.locator('.album button')
  await expect(tile.locator('video')).toHaveCSS('filter', 'blur(16px)')
  await tile.click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(tile.locator('video')).toHaveCSS('filter', 'none')
  await tile.click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('button', { name: '关闭视频' }).click()
  await page.getByRole('button', { name: '清除', exact: true }).click()
  await expect(page).toHaveURL(/layout=album/)
  await expect(page.locator('.album button')).toHaveCount(3)
  expect(queries.every((q) => !q.has('layout'))).toBe(true)
  await page.reload()
  await expect(
    page.getByRole('button', { name: '相册', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')
})
test('album keeps paging when the first page has no media', async ({
  page,
}) => {
  const queries = await setup(page, true)
  await page.goto('/app/#/?layout=album')
  await expect(page.locator('.album button')).toHaveCount(3)
  expect(queries.some((q) => q.get('cursor') === 'page2')).toBe(true)
})

test('feed preview can open its collection and return to the feed', async ({
  page,
}) => {
  await setup(page)
  await page.goto('/app/')
  await page
    .locator('.row')
    .first()
    .getByRole('button', { name: '放大图片' })
    .click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '打开收藏详情' })
    .click()
  await expect(page).toHaveURL(new RegExp(`/collection/${first}$`))
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('button', { name: '返回', exact: true }).click()
  await expect(
    page.getByRole('button', { name: '信息流', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')
})
