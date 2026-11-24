import { expect, test } from '@playwright/test'
const item = (n: number) => ({
  id: `11111111-1111-4111-8111-11111111111${n}`,
  url: `https://example.test/post/${n}`,
  text: `第 ${n} 条收藏`,
  author_name: `作者${n}`,
  saved_at: '2026-09-29T10:00:00Z',
  observed_at: '2026-09-29T10:00:00Z',
  revision_id: `r${n}`,
  assets: [],
})
const items = [item(1), item(2), item(3)]

test('select collections and update them as one record', async ({ page }) => {
  let started: unknown
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (r) => {
    const path = new URL(r.request().url()).pathname
    if (path === '/v1/session') return r.fulfill({ json: {} })
    if (path === '/v1/usage')
      return r.fulfill({
        json: { used_bytes: 0 },
      })
    if (path === '/v1/collections') return r.fulfill({ json: { items } })
    if (path === '/v1/updates/preview')
      return r.fulfill({ json: { posts: 2, profiles: 0, listable: 0 } })
    if (path === '/v1/updates') {
      started = r.request().postDataJSON()
      return r.fulfill({ json: { id: 'record' } })
    }
    return r.fulfill({ status: 404, json: { error: '内容不存在或已删除' } })
  })
  await page.goto('/app/')
  await expect(page.getByText('第 1 条收藏')).toBeVisible()
  await page.getByRole('button', { name: '批量更新' }).click()
  // Selecting toggles rows instead of opening them.
  await page.getByRole('checkbox', { name: /作者1/ }).click()
  await page.getByRole('checkbox', { name: /作者3/ }).click()
  await expect(page.getByRole('checkbox', { checked: true })).toHaveCount(2)
  await expect(page).toHaveURL(/#\/$/)
  await expect(page.getByText('已选 2 项')).toBeVisible()
  await page.getByRole('button', { name: '更新', exact: true }).click()
  // The sheet says what the update covers; posts have no options.
  const sheet = page.getByRole('dialog', { name: '更新 2 条帖子' })
  await expect(sheet).toBeVisible()
  await expect(sheet.getByText('抓帖子')).toHaveCount(0)
  await sheet.getByRole('button', { name: '开始更新' }).click()
  // Selection ends; the bar confirms and links to the update's one record.
  await expect(page.getByRole('checkbox')).toHaveCount(0)
  await expect(page.getByText('已开始更新 2 项')).toBeVisible()
  await expect(page.getByRole('button', { name: '批量更新' })).toBeVisible()
  expect(started).toEqual({
    target: { target: 'many', ids: [items[0].id, items[2].id] },
  })
  await page.getByRole('button', { name: '查看进度' }).click()
  await expect(page).toHaveURL(/#\/captures\/record$/)
})

test('select all toggles every listed collection', async ({ page }) => {
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (r) => {
    const path = new URL(r.request().url()).pathname
    if (path === '/v1/session') return r.fulfill({ json: {} })
    if (path === '/v1/collections') return r.fulfill({ json: { items } })
    return r.fulfill({ status: 404, json: { error: '内容不存在或已删除' } })
  })
  await page.goto('/app/')
  await page.getByRole('button', { name: '批量更新' }).click()
  await page.getByRole('button', { name: '全选' }).click()
  await expect(page.getByText('已选 3 项')).toBeVisible()
  await page.getByRole('button', { name: '取消全选' }).click()
  await expect(page.getByText('已选 0 项')).toBeVisible()
  await expect(
    page.getByRole('button', { name: '更新', exact: true }),
  ).toBeDisabled()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.getByRole('checkbox')).toHaveCount(0)
})
