import { expect, test } from './test'
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
  await page.getByRole('button', { name: '多选' }).click()
  const bar = page.getByRole('region', { name: '多选' })
  // Selecting toggles rows instead of opening them.
  await page.getByRole('checkbox', { name: /作者1/ }).click()
  await page.getByRole('checkbox', { name: /作者3/ }).click()
  await expect(page.getByRole('checkbox', { checked: true })).toHaveCount(2)
  await expect(page).toHaveURL(/\/app\/$/)
  await expect(bar.getByText('已选 2 项')).toBeVisible()
  await page.getByRole('button', { name: '更新', exact: true }).click()
  // The sheet says what the update covers; posts have only their own.
  const sheet = page.getByRole('dialog', { name: '更新 2 条帖子' })
  await expect(sheet).toBeVisible()
  await expect(sheet.getByText('抓帖子')).toHaveCount(0)
  await expect(sheet.getByText('抓关系网')).toHaveCount(0)
  await expect(sheet.getByLabel('采集引用、转发的原帖')).toBeChecked()
  await sheet.getByRole('button', { name: '开始更新' }).click()
  // Selection ends; the bar confirms and links to the update's one record.
  await expect(page.getByRole('checkbox')).toHaveCount(0)
  await expect(page.getByText('已开始更新 2 项')).toBeVisible()
  await expect(page.getByRole('button', { name: '多选' })).toBeVisible()
  expect(started).toEqual({
    target: { target: 'many', ids: [items[0].id, items[2].id] },
    options: {
      posts: 'latest',
      count: 100,
      media_only: false,
      include_shared: true,
      capture_references: true,
      relations: false,
    },
  })
  await page.getByRole('link', { name: '查看进度' }).click()
  await expect(page).toHaveURL(/\/app\/captures\/record$/)
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
  await page.getByRole('button', { name: '多选' }).click()
  const bar = page.getByRole('region', { name: '多选' })
  await page.getByRole('button', { name: '全选' }).click()
  await expect(bar.getByText('已选 3 项')).toBeVisible()
  await page.getByRole('button', { name: '取消全选' }).click()
  await expect(bar.getByText('已选 0 项')).toBeVisible()
  await expect(
    page.getByRole('button', { name: '更新', exact: true }),
  ).toBeDisabled()
  await expect(page.getByRole('button', { name: '更多操作' })).toBeDisabled()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.getByRole('checkbox')).toHaveCount(0)
})

test("delete a selection, with the accounts' posts only when asked", async ({
  page,
}) => {
  const sent: unknown[] = []
  let listed = items
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (r) => {
    const path = new URL(r.request().url()).pathname
    if (path === '/v1/session') return r.fulfill({ json: {} })
    if (path === '/v1/usage') return r.fulfill({ json: { used_bytes: 0 } })
    if (path === '/v1/collections')
      return r.fulfill({ json: { items: listed } })
    if (path === '/v1/collections/delete') {
      const body = r.request().postDataJSON() as {
        ids: string[]
        dry_run: boolean
      }
      sent.push(body)
      if (!body.dry_run)
        listed = listed.filter((item) => !body.ids.includes(item.id))
      return r.fulfill({
        json: {
          profiles: 1,
          posts: 1,
          related: 410,
          kept: { listed: 12, saved: 20, annotated: 5, quoted: 0 },
        },
      })
    }
    return r.fulfill({ status: 404, json: { error: '内容不存在或已删除' } })
  })
  await page.goto('/app/')
  await page.getByRole('button', { name: '多选' }).click()
  const more = page.getByRole('button', { name: '更多操作' })
  await expect(more).toBeDisabled()
  await page.getByRole('checkbox', { name: /作者1/ }).click()
  await page.getByRole('checkbox', { name: /作者2/ }).click()
  await more.click()
  const menu = page.getByRole('dialog', { name: '已选 2 项' })
  await menu.getByRole('button', { name: '删除', exact: true }).click()
  await expect(menu).toBeHidden()
  const sheet = page.getByRole('dialog', { name: '删除 2 项收藏？' })
  await expect(sheet.getByText('将删除 1 个账号、1 条帖子')).toBeVisible()
  // The accounts' posts stay unless asked for.
  const option = sheet.getByRole('checkbox', { name: '同时删除关联的帖子' })
  await expect(option).not.toBeChecked()
  await option.check()
  await expect(
    sheet.getByText(
      '将删除 1 个账号、411 条帖子（保留 37 条：其他账号也关联 12 条、单独收藏 20 条、已整理 5 条）',
    ),
  ).toBeVisible()
  await sheet.getByRole('button', { name: '删除', exact: true }).click()
  await expect(page.getByText('第 1 条收藏')).toHaveCount(0)
  await expect(page.getByText('第 3 条收藏')).toBeVisible()
  await expect(page.getByRole('checkbox')).toHaveCount(0)
  const ids = [items[0].id, items[1].id]
  expect(sent).toEqual([
    { ids, with_posts: true, dry_run: true },
    { ids, with_posts: true, dry_run: false },
  ])
})
