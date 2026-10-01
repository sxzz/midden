import { expect, test } from '@playwright/test'

const items = Array.from({ length: 30 }, (_, index) => ({
  id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
  text: `收藏 ${index}`,
  author_name: `作者 ${index}`,
  url: 'https://example.test/post',
  saved_at: '2026-09-29T10:00:00Z',
  observed_at: '2026-09-29T10:00:00Z',
  revision_id: 'r1',
  assets: [{ id: `image-${index}`, state: 'ready', mime: 'image/png' }],
}))

for (const back of ['button', 'history'] as const) {
  test(`keeps loaded thumbnails, query and scroll on ${back} return`, async ({
    page,
  }) => {
    let listRequests = 0
    await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
    await page.route('**/v1/**', (r) => {
      const path = new URL(r.request().url()).pathname
      if (path.startsWith('/v1/assets/'))
        return r.fulfill({
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="54" height="54"><path fill="red" d="M0 0h54v54H0z"/></svg>',
        })
      if (path === '/v1/collections') {
        listRequests++
        return r.fulfill({ json: { items } })
      }
      return r.fulfill({
        json: path.endsWith('/availability')
          ? { available: true }
          : path.endsWith('/revisions')
            ? { items: [] }
            : items.find((item) => path === `/v1/collections/${item.id}`) || {},
      })
    })
    await page.goto('/app/#/?q=test')
    const row = page.locator('.row').nth(15)
    await row.scrollIntoViewIfNeeded()
    const img = row.locator('img')
    await expect(img).not.toHaveClass(/pending/)
    const original = await img.elementHandle()
    const scroll = await page.evaluate(() => window.scrollY)
    await row.click()
    await expect(page.locator('h1')).toHaveText('收藏详情')
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
    if (back === 'button')
      await page.getByRole('button', { name: '返回' }).click()
    else await page.goBack()
    await expect(page.locator('h1')).toHaveText('我的收藏')
    await expect(page).toHaveURL(/#\/\?q=test$/)
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scroll)
    expect(await img.evaluate((node, saved) => node === saved, original)).toBe(
      true,
    )
    await expect(img).not.toHaveClass(/pending/)
    expect(listRequests).toBe(1)
    if (back === 'history') {
      await page.goForward()
      await expect(page.locator('h1')).toHaveText('收藏详情')
      await page.reload()
      await expect(page.getByText('收藏 15', { exact: true })).toBeVisible()
      await page.getByRole('button', { name: '返回' }).click()
      await expect(page.locator('.row')).toHaveCount(30)
    }
  })
}

test('Telegram back from a directly opened collection returns home', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const noop = () => {}
    Object.assign(globalThis, {
      Telegram: {
        WebApp: {
          initData: 'test',
          themeParams: {},
          colorScheme: 'light',
          ready: noop,
          expand: noop,
          onEvent: noop,
          offEvent: noop,
          BackButton: {
            show: noop,
            hide: noop,
            offClick: noop,
            onClick: (back: () => void) => {
              Object.assign(globalThis, { telegramBack: back })
            },
          },
        },
      },
    })
  })
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (r) => {
    const path = new URL(r.request().url()).pathname
    return r.fulfill({
      json:
        path === '/v1/collections' || path.endsWith('/revisions')
          ? { items: [] }
          : path === `/v1/collections/${items[0]!.id}`
            ? items[0]
            : path === '/v1/tags'
              ? []
              : path.endsWith('/annotation')
                ? { note: '', tags: [] }
                : {},
    })
  })
  await page.goto(`/app/#/collection/${items[0]!.id}`)
  await expect(page.locator('h1')).toHaveText('收藏详情')
  await page.evaluate(() =>
    (globalThis as unknown as { telegramBack: () => void }).telegramBack(),
  )
  await expect(page.locator('h1')).toHaveText('我的收藏')
  await expect(page).toHaveURL(/#\/$/)
})
