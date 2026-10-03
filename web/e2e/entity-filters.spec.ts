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

test('entity tabs keep their own filters and mobile statistic layout', async ({
  page,
}) => {
  const queries: URLSearchParams[] = []
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (r) => {
    const url = new URL(r.request().url())
    if (url.pathname === '/v1/collections') queries.push(url.searchParams)
    return r.fulfill({
      json:
        url.pathname === `/v1/collections/${id}`
          ? profile
          : url.pathname.endsWith('/availability')
            ? { available: true }
            : { items: [profile] },
    })
  })
  const type = () => queries.at(-1)?.get('entity_type')
  await page.goto('/app/')
  await expect(page.getByRole('button', { name: /测试账号/ })).toBeVisible()
  expect(type()).toBe('x.post')
  const posts = page.getByRole('tab', { name: '帖子' })
  const accounts = page.getByRole('tab', { name: '账号' })
  await expect(posts).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('button', { name: /^筛选/ }).click()
  await page.getByLabel('可见性').selectOption('public')
  await expect.poll(() => queries.at(-1)?.get('visibility')).toBe('public')
  await accounts.click()
  await expect(accounts).toHaveAttribute('aria-selected', 'true')
  await expect.poll(type).toBe('x.profile')
  // The posts tab's filter stays with the posts tab.
  expect(queries.at(-1)?.get('visibility')).toBeNull()
  await page.getByRole('button', { name: /^筛选/ }).click()
  // An account has no author, media or sensitivity to filter by.
  await expect(page.locator('summary[aria-label="作者"]')).toHaveCount(0)
  await expect(page.locator('summary[aria-label="媒体类型"]')).toHaveCount(0)
  await expect(page.getByLabel('敏感内容', { exact: true })).toHaveCount(0)
  await page.getByLabel('可见性').selectOption('private')
  await expect.poll(() => queries.at(-1)?.get('visibility')).toBe('private')
  expect(type()).toBe('x.profile')
  const requests = queries.length
  await posts.click()
  await expect(page.getByLabel('可见性')).toHaveValue('public')
  await accounts.click()
  await expect(page.getByLabel('可见性')).toHaveValue('private')
  // Both lists were cached, so neither switch reached the server.
  expect(queries.length).toBe(requests)
  await page.reload()
  await expect(accounts).toHaveAttribute('aria-selected', 'true')
  await expect.poll(type).toBe('x.profile')
  expect(queries.at(-1)?.get('visibility')).toBe('private')
  // Clearing drops the filters, not the tab.
  await page.getByRole('button', { name: '清除', exact: true }).click()
  await expect.poll(() => queries.at(-1)?.get('visibility')).toBeNull()
  expect(type()).toBe('x.profile')
  await expect(accounts).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('button', { name: '清除' })).toHaveCount(0)
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
  await expect(page.locator('.row .storage')).toContainText('2.0 MB')
  await page.getByRole('button', { name: /^筛选/ }).click()
  await page.locator('summary[aria-label="媒体类型"]').click()
  await page.getByRole('option', { name: '图片', exact: true }).click()
  await page.getByRole('option', { name: '视频', exact: true }).click()
  // No date field is on screen until a custom range is asked for.
  const range = page.getByLabel('收藏日期', { exact: true })
  await expect(page.getByLabel('收藏开始日期')).toHaveCount(0)
  await range.selectOption('6')
  await expect.poll(() => query.get('saved_from')).toBeTruthy()
  expect(query.get('saved_before')).toBeNull()
  await expect(page.getByRole('button', { name: /^筛选/ })).toContainText(
    '最近 7 天',
  )
  await range.selectOption('custom')
  await page.getByLabel('收藏开始日期').fill('2026-09-01')
  await page.getByLabel('收藏结束日期').fill('2026-09-30')
  await page.getByLabel('可见性').selectOption('private')
  await expect.poll(() => query.get('visibility')).toBe('private')
  await expect.poll(() => query.get('media_type')).toBe('image,video')
  await expect.poll(() => query.get('saved_from')).toBeTruthy()
  await expect.poll(() => query.get('saved_before')).toBeTruthy()
  await page.reload()
  await expect(page.getByLabel('收藏日期', { exact: true })).toHaveValue(
    'custom',
  )
  await expect(page.getByLabel('收藏开始日期')).toHaveValue('2026-09-01')
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
  await expect(page.getByLabel('收藏日期', { exact: true })).toHaveValue('')
  await expect(page.getByLabel('收藏开始日期')).toHaveCount(0)
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
