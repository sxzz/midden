import { expect, test } from '@playwright/test'
const item = (n: number) => ({
  id: `11111111-1111-4111-8111-11111111111${n}`,
  url: `https://example.test/post/${n}`,
  text: `第 ${n} 条收藏`,
  author_name: `作者${n}`,
  saved_at: '2026-09-29T10:00:00Z',
  observed_at: '2026-09-29T10:00:00Z',
  visibility: 'public',
  revision_id: `r${n}`,
  assets: [],
})
const items = [item(1), item(2), item(3)]

test('select collections and refresh them in append mode', async ({ page }) => {
  let started: { collection_ids: string[]; update_mode: string } | undefined
  let polls = 0
  let listLoads = 0
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (r) => {
    const path = new URL(r.request().url()).pathname
    if (path === '/v1/session') return r.fulfill({ json: { tenant_id: 'x' } })
    if (path === '/v1/usage')
      return r.fulfill({
        json: { used_bytes: 0, reserved_bytes: 0, limit_bytes: 1 << 30 },
      })
    if (path === '/v1/collections') {
      listLoads++
      return r.fulfill({ json: { items } })
    }
    const batch = {
      id: 'batch',
      update_mode: 'append',
      total: 2,
      reused: 1,
      rejected: 0,
      partial: 0,
      failed: 0,
    }
    if (path === '/v1/refresh-batches') {
      started = r.request().postDataJSON()
      return r.fulfill({
        status: 202,
        json: {
          ...batch,
          state: 'running',
          submitted: 0,
          running: 0,
          complete: 0,
        },
      })
    }
    if (path === '/v1/refresh-batches/batch') {
      polls++
      return r.fulfill({
        json:
          polls < 2
            ? {
                ...batch,
                state: 'running',
                submitted: 1,
                running: 1,
                complete: 0,
              }
            : {
                ...batch,
                state: 'complete',
                submitted: 2,
                running: 0,
                complete: 2,
              },
      })
    }
    return r.fulfill({ status: 404, json: { error: 'not found' } })
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
  await page.screenshot({ path: 'test-results/batch-select-mobile.png' })
  await page.getByRole('button', { name: '更新', exact: true }).click()
  await expect(page.getByText('更新 2 项收藏')).toBeVisible()
  await page.screenshot({ path: 'test-results/batch-mode-mobile.png' })
  const loadsBefore = listLoads
  await page.getByRole('button', { name: /附加更新/ }).click()
  expect(started).toEqual({
    collection_ids: [items[0].id, items[2].id],
    update_mode: 'append',
  })
  await expect(page.getByText('更新中 1/2')).toBeVisible()
  await expect(page.getByText('完成：已抓取 1 · 无变化 1')).toBeVisible()
  // The finished batch reloads the list so refreshed content shows.
  await expect.poll(() => listLoads).toBeGreaterThan(loadsBefore)
  await page.getByRole('button', { name: '完成' }).click()
  await expect(page.getByRole('checkbox')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '批量更新' })).toBeVisible()
})

test('select all toggles every listed collection', async ({ page }) => {
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (r) => {
    const path = new URL(r.request().url()).pathname
    if (path === '/v1/session') return r.fulfill({ json: { tenant_id: 'x' } })
    if (path === '/v1/collections') return r.fulfill({ json: { items } })
    return r.fulfill({ status: 404, json: { error: 'not found' } })
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
