import { expect, test, type Page } from '@playwright/test'

const uuid = (n: number) =>
  `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`
const profileId = uuid(1)
const relatedIds = [11, 12, 13, 14, 15].map(uuid)
const fillerIds = [21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32].map(uuid)
const base = {
  url: 'https://example.test/item',
  observed_at: '2026-09-30T10:00:00Z',
  saved_at: '2026-09-30T10:00:00Z',
  visibility: 'public',
  revision_id: 'revision-1',
}
const profile = {
  ...base,
  id: profileId,
  text: '合成主页简介',
  author_name: '合成主页',
  assets: [],
  graph: {
    root: 'profile',
    relations: [],
    entities: [
      {
        key: 'profile',
        type: 'x.profile',
        external_id: '100',
        data: { username: 'synthetic' },
      },
    ],
  },
}
const post = (id: string, label: string) => ({
  ...base,
  id,
  text: `合成帖子 ${label}`,
  author_name: '合成主页',
  assets: [{ id: `asset-${label}`, mime: 'image/png', state: 'ready' }],
})
const related = relatedIds.map((id, index) => post(id, String(index + 1)))
const fillers = fillerIds.map((id, index) => post(id, `填充 ${index + 1}`))
const details = [profile, ...related, ...fillers]

/** Mocks the whole API from synthetic records and records every request. */
async function setup(page: Page) {
  const requests: URL[] = []
  await page.route('https://telegram.org/**', (route) =>
    route.fulfill({ body: '' }),
  )
  await page.route('**/v1/**', (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    if (path.startsWith('/v1/assets/'))
      return route.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#678"/></svg>',
      })
    requests.push(url)
    if (path === '/v1/collections') {
      if (url.searchParams.get('related_to') !== profileId)
        return route.fulfill({ json: { items: [profile, ...fillers] } })
      const ordered =
        url.searchParams.get('order') === 'asc' ? related : related.toReversed()
      return route.fulfill({
        json: url.searchParams.has('cursor')
          ? { items: ordered.slice(3), total_storage_bytes: 2048 }
          : {
              items: ordered.slice(0, 3),
              next_cursor: 'page-2',
              total_storage_bytes: 2048,
            },
      })
    }
    if (path.endsWith('/revisions'))
      return route.fulfill({ json: { items: [] } })
    if (path.endsWith('/availability'))
      return route.fulfill({ json: { available: true } })
    if (path.endsWith('/annotation'))
      return route.fulfill({ json: { note: '', tags: [] } })
    if (path === '/v1/tags') return route.fulfill({ json: [] })
    if (path === '/v1/usage')
      return route.fulfill({
        json: { used_bytes: 0, reserved_bytes: 0, limit_bytes: 1000 },
      })
    return route.fulfill({
      json: details.find((item) => path === `/v1/collections/${item.id}`) || {},
    })
  })
  return {
    relatedLoads: () =>
      requests.filter(
        (url) =>
          url.pathname === '/v1/collections' &&
          url.searchParams.get('related_to') === profileId,
      ).length,
    detailLoads: (id: string) =>
      requests.filter((url) => url.pathname === `/v1/collections/${id}`).length,
  }
}

const backButton = (page: Page) =>
  page.getByRole('button', { name: '返回', exact: true })
const scrollTo = (page: Page, top: number) =>
  page.evaluate((y) => {
    window.scrollTo(0, y)
    return window.scrollY
  }, top)
const scrollY = (page: Page) => page.evaluate(() => window.scrollY)

test('a profile keeps its related order, layout and pages after a nested post', async ({
  page,
}) => {
  const counts = await setup(page)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`/app/#/collection/${profileId}`)
  const list = page.getByRole('region', { name: '关联的收藏' })
  await expect(list.locator('.row')).toHaveCount(3)
  await expect(list.locator('.row').first()).toContainText('合成帖子 5')
  const order = list.getByRole('button', { name: /发布时间排序/ })
  await order.click()
  await expect(order).toHaveText('正序 ↑')
  await expect(list.locator('.row').first()).toContainText('合成帖子 1')
  // Reach the second page, then remember the whole list in album layout.
  await scrollTo(page, 100_000)
  await expect(list.locator('.row')).toHaveCount(5)
  const album = list.getByRole('button', { name: '相册', exact: true })
  await album.click()
  await expect(list.locator('.album button')).toHaveCount(5)
  const relatedLoads = counts.relatedLoads()
  expect(counts.detailLoads(profileId)).toBe(1)

  await list.locator('.album button').first().click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: '打开收藏详情' })
    .click()
  await expect(page).toHaveURL(new RegExp(`/collection/${relatedIds[0]}$`))
  await expect(page.locator('.post .body')).toHaveText('合成帖子 1')
  await backButton(page).click()

  await expect(page).toHaveURL(new RegExp(`/collection/${profileId}$`))
  // The cached profile keeps its own identity, order, layout and both pages.
  await expect(page.locator('.post .body')).toHaveText('合成主页简介')
  await expect(order).toHaveText('正序 ↑')
  await expect(album).toHaveAttribute('aria-pressed', 'true')
  await expect(list.locator('.album button')).toHaveCount(5)
  expect(counts.relatedLoads()).toBe(relatedLoads)
  expect(counts.detailLoads(profileId)).toBe(1)
  expect(errors).toEqual([])
})

test('the list and a profile each return to their own scroll position', async ({
  page,
}) => {
  const counts = await setup(page)
  await page.goto('/app/#/?q=fixture')
  await expect(page.locator('.row')).toHaveCount(13)
  const listScroll = await scrollTo(page, 300)
  expect(listScroll).toBeGreaterThan(0)

  // Dispatch instead of click: a real click would scroll the row into view.
  await page.locator('.row', { hasText: '@synthetic' }).dispatchEvent('click')
  await expect(page).toHaveURL(new RegExp(`/collection/${profileId}$`))
  await expect.poll(() => scrollY(page)).toBe(0)
  const list = page.getByRole('region', { name: '关联的收藏' })
  await expect(list.locator('.row')).toHaveCount(3)
  await scrollTo(page, 100_000)
  await expect(list.locator('.row')).toHaveCount(5)
  const profileScroll = await scrollTo(page, 600)
  expect(profileScroll).toBeGreaterThan(0)

  await list.locator('.row').first().dispatchEvent('click')
  await expect(page).toHaveURL(new RegExp(`/collection/${relatedIds[4]}$`))
  await expect.poll(() => scrollY(page)).toBe(0)

  await backButton(page).click()
  await expect(page).toHaveURL(new RegExp(`/collection/${profileId}$`))
  await expect.poll(() => scrollY(page)).toBe(profileScroll)
  await expect(list.locator('.row')).toHaveCount(5)

  await backButton(page).click()
  await expect(page).toHaveURL(/#\/\?q=fixture$/)
  await expect.poll(() => scrollY(page)).toBe(listScroll)
  await expect(page.locator('.row')).toHaveCount(13)
  expect(counts.detailLoads(profileId)).toBe(1)
})
