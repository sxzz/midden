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
  await expect.poll(() => queries.at(-1)).toBe('x.profile')
  await page.reload()
  await expect(page.getByRole('button', { name: /^筛选/ })).toContainText(
    'X 账号',
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

test('Chinese filters support multiple media, date bounds and storage order', async ({
  page,
}) => {
  let query = new URLSearchParams()
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (r) => {
    const url = new URL(r.request().url())
    if (url.pathname === '/v1/collections') query = url.searchParams
    return r.fulfill({
      json: { items: [{ ...profile, storage_bytes: 2097152 }] },
    })
  })
  await page.goto('/app/')
  await expect(page.locator('.row .meta')).toContainText('2.0 MB')
  await page.getByRole('button', { name: /^筛选/ }).click()
  await expect(
    page.getByLabel('类型', { exact: true }).locator('option:checked'),
  ).toHaveText('X 帖子')
  await page.locator('summary[aria-label="媒体类型"]').click()
  await page.getByRole('option', { name: '图片', exact: true }).click()
  await page.getByRole('option', { name: '视频', exact: true }).click()
  await page.getByLabel('收藏开始日期').fill('2026-09-01')
  await page.getByLabel('收藏结束日期').fill('2026-09-30')
  await expect(page.getByText(/并非收藏的分享设置/)).toBeVisible()
  await expect.poll(() => query.get('media_type')).toBe('image,video')
  expect(query.get('saved_from')).toBeTruthy()
  expect(query.get('saved_before')).toBeTruthy()
  await page.reload()
  await page.locator('summary[aria-label="媒体类型"]').click()
  await expect(
    page.getByRole('option', { name: '图片', exact: true }),
  ).toHaveAttribute('aria-selected', 'true')
  await expect(
    page.getByRole('option', { name: '视频', exact: true }),
  ).toHaveAttribute('aria-selected', 'true')
  await page.getByLabel('排序', { exact: true }).selectOption('storage')
  await expect.poll(() => query.get('sort')).toBe('storage')
  await expect(
    page.getByLabel('排序方向').locator('option:checked'),
  ).toHaveText('从大到小')
  await page.getByLabel('排序方向').selectOption('asc')
  await expect.poll(() => query.get('order')).toBe('asc')
  await page.getByRole('button', { name: '清除', exact: true }).click()
  await expect.poll(() => query.get('media_type')).toBeNull()
})

test('author dropdown searches names but filters by stable identity', async ({
  page,
}) => {
  let query = new URLSearchParams()
  // The last two are different accounts under one display name: picking one
  // must send only its own id, never the shared name.
  const authors = [
    { id: 'x/x.profile/1', name: '作者甲' },
    { id: 'x/x.profile/2', name: "作者乙, O'Reilly" },
    { id: 'x/x.profile/3', name: "作者乙, O'Reilly" },
  ]
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (r) => {
    const url = new URL(r.request().url())
    if (url.pathname === '/v1/collections/authors')
      return r.fulfill({ json: { items: authors } })
    if (url.pathname === '/v1/collections') query = url.searchParams
    return r.fulfill({ json: { items: [profile] } })
  })
  await page.goto('/app/')
  await page.getByRole('button', { name: /^筛选/ }).click()
  await page.locator('summary[aria-label="作者"]').click()
  await page.getByRole('option', { name: '作者甲', exact: true }).click()
  await page.getByRole('searchbox', { name: '搜索作者' }).fill('乙')
  const list = page.getByRole('listbox', { name: '作者', exact: true })
  await expect(list.getByRole('option')).toHaveCount(2)
  await list
    .getByRole('option', { name: authors[1]!.name, exact: true })
    .first()
    .click()
  await expect
    .poll(() => query.getAll('author'))
    .toEqual([authors[0]!.id, authors[1]!.id])
  await page.reload()
  await page.locator('summary[aria-label="作者"]').click()
  // The same-named account that was not chosen stays unselected.
  await expect(
    page.getByRole('option', { name: '作者甲', exact: true }),
  ).toHaveAttribute('aria-selected', 'true')
  const named = page.getByRole('option', {
    name: authors[1]!.name,
    exact: true,
  })
  await expect(named.nth(0)).toHaveAttribute('aria-selected', 'true')
  await expect(named.nth(1)).toHaveAttribute('aria-selected', 'false')
  await page.getByRole('option', { name: '作者甲', exact: true }).click()
  await expect.poll(() => query.getAll('author')).toEqual([authors[1]!.id])
  await page.getByRole('button', { name: '清除', exact: true }).click()
  await expect.poll(() => query.getAll('author')).toEqual([])
})

test('sensitive filter applies immediately and clears', async ({ page }) => {
  let query = new URLSearchParams()
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (r) => {
    const url = new URL(r.request().url())
    if (url.pathname === '/v1/collections/authors')
      return r.fulfill({ json: { items: [] } })
    if (url.pathname === '/v1/collections') query = url.searchParams
    return r.fulfill({ json: { items: [profile] } })
  })
  await page.goto('/app/')
  const panel = page.getByRole('button', { name: /^筛选/ })
  await panel.click()
  const select = page.getByLabel('敏感内容', { exact: true })
  await expect(select.locator('option')).toHaveText(['全部', '包含', '不包含'])
  await select.selectOption('contains')
  await expect.poll(() => query.get('sensitive')).toBe('contains')
  await expect(panel).toContainText('包含敏感内容')
  await select.selectOption('not_contains')
  await expect.poll(() => query.get('sensitive')).toBe('not_contains')
  await page.reload()
  await expect(page.getByLabel('敏感内容', { exact: true })).toHaveValue(
    'not_contains',
  )
  await page.getByRole('button', { name: '清除', exact: true }).click()
  await expect.poll(() => query.get('sensitive')).toBeNull()
})
