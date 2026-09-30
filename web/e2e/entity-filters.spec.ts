import { expect, test } from '@playwright/test'

const id = '11111111-1111-4111-8111-111111111111'
const profile = {
  id,
  url: 'https://example.test/profile',
  text: '简介',
  author_name: '测试账号',
  observed_at: '2026-09-30T10:00:00Z',
  visibility: 'public',
  revision_id: 'r1',
  assets: [],
  graph: {
    root: 'profile',
    relations: [],
    entities: [
      {
        key: 'profile',
        type: 'x.profile',
        data: {
          username: 'fixture',
          metadata: {
            followers: 8320,
            following: 2965,
            statuses: 66883,
            media_count: 6145,
            likes: 202562,
          },
        },
      },
    ],
  },
}

test('entity defaults, switching, resetting and mobile statistic layout', async ({
  page,
}) => {
  const queries: string[] = []
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (r) => {
    const url = new URL(r.request().url())
    if (url.pathname === '/v1/collections')
      queries.push(url.searchParams.get('entity_type') || '')
    return r.fulfill({
      json:
        url.pathname === `/v1/collections/${id}`
          ? profile
          : url.pathname.endsWith('/availability')
            ? { available: true }
            : { items: [profile] },
    })
  })
  await page.goto('/app/')
  await expect(page.getByRole('button', { name: /测试账号/ })).toBeVisible()
  expect(queries.at(-1)).toBe('x.post')
  await page.getByRole('button', { name: /^筛选/ }).click()
  await expect(page.getByLabel('类型', { exact: true })).toHaveValue('x.post')
  await page.getByLabel('类型', { exact: true }).selectOption('x.profile')
  await page.getByRole('button', { name: '应用筛选' }).click()
  await expect.poll(() => queries.at(-1)).toBe('x.profile')
  await page.reload()
  await expect(page.getByRole('button', { name: /^筛选/ })).toContainText(
    'X profile',
  )
  await page.getByRole('button', { name: '清除', exact: true }).click()
  await expect.poll(() => queries.at(-1)).toBe('x.post')
  await page.getByRole('button', { name: /测试账号/ }).click()
  for (const width of [320, 390, 560]) {
    await page.setViewportSize({ width, height: 844 })
    const counts = page.locator('.stat dd')
    await expect(counts).toHaveCount(5)
    for (const count of await counts.all()) {
      expect(
        await count.evaluate((el) => {
          const range = document.createRange()
          range.selectNodeContents(el)
          const rects = [...range.getClientRects()]
          return (
            rects.length === 1 &&
            rects[0]!.right <= document.documentElement.clientWidth
          )
        }),
      ).toBe(true)
    }
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: 'test-results/profile-stats-mobile.png' })
})
