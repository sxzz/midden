import { expect, test, type Page } from './test'

const profileId = '77777777-7777-4777-8777-777777777777'
const profile = {
  id: profileId,
  url: 'https://example.test/owner',
  observed_at: '2026-11-05T08:00:00Z',
  saved_at: '2026-11-01T08:00:00Z',
  revision_id: 'revision-1',
  author_name: '合成账号',
  text: '合成简介',
  assets: [],
  graph: {
    root: 'profile',
    relations: [],
    entities: [
      {
        key: 'profile',
        type: 'x.profile',
        external_id: '100',
        data: { name: '合成账号', username: 'owner', metadata: {} },
      },
    ],
  },
}
const defaults = {
  posts: 'latest',
  count: 100,
  media_only: false,
  include_shared: true,
  capture_references: true,
  relations: false,
}

/** The API, with watches kept as the server would keep them. */
async function serve(page: Page) {
  const sent: { method: string; path: string; body?: unknown }[] = []
  let watch: Record<string, unknown> | undefined
  const next = new Date()
  next.setHours(23, 5, 0, 0)
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const method = request.method()
    if (path.startsWith('/v1/watches') && method !== 'GET')
      sent.push({
        method,
        path,
        ...(request.postData() ? { body: request.postDataJSON() } : {}),
      })
    let json: unknown = {}
    if (path === '/v1/watches') {
      if (method === 'PUT') {
        const body = request.postDataJSON() as Record<string, unknown>
        watch = {
          ...watch,
          id: 'watch',
          target: body.target,
          target_id: body.id,
          handle: 'owner',
          url: profile.url,
          every: body.every,
          time_zone: body.time_zone,
          options: body.options,
          enabled: true,
          next_run_at: next.toISOString(),
          created_at: '2026-11-26T00:00:00Z',
        }
        json = watch
      } else json = { items: watch ? [watch] : [] }
    } else if (path === '/v1/watches/watch' && method === 'PATCH') {
      watch = { ...watch, ...(request.postDataJSON() as object) }
      json = watch
    } else if (path === '/v1/collections') json = { items: [] }
    else if (path === '/v1/updates/preview')
      json = { posts: 0, profiles: 1, listable: 1 }
    else if (path.endsWith('/history')) json = { items: [] }
    else if (path.endsWith('/counts')) json = { points: [] }
    else if (path.endsWith('/availability')) json = { available: true }
    else if (path.endsWith('/annotation')) json = { note: '', tags: [] }
    else if (path === '/v1/tags' || path.startsWith('/v1/shares')) json = []
    else if (path === `/v1/collections/${profileId}`) json = profile
    return route.fulfill({ json })
  })
  return {
    sent,
    setLastRun: (run: object) => (watch = { ...watch, last_run: run }),
  }
}

test('watch a profile from its detail, then edit the watch', async ({
  page,
}) => {
  const { sent, setLastRun } = await serve(page)
  await page.goto(`/collection/${profileId}`)
  const update = page.locator('.section.update')
  const row = update.getByRole('button', { name: /^定期更新/ })
  await expect(row).toBeVisible()
  await expect(row).not.toContainText('下次')
  await row.click()

  const sheet = page.getByRole('dialog', { name: '定期更新 @owner' })
  await expect(sheet).toBeVisible()
  // The 更新 sheet's options, with its defaults, and how often.
  await expect(sheet.getByLabel('间隔')).toHaveValue('1')
  await expect(sheet.getByLabel('单位')).toHaveValue('day')
  await expect(sheet.getByText('最短 5 分钟')).toBeVisible()
  await expect(sheet.getByLabel('抓帖子')).toBeChecked()
  await expect(sheet.getByLabel('抓关系网')).not.toBeChecked()
  // A custom interval: every 6 hours.
  await sheet.getByLabel('间隔').fill('6')
  await sheet.getByLabel('单位').selectOption('hour')
  await sheet.getByLabel('帖子范围').selectOption('until_existing')
  await sheet.getByLabel('抓关系网').check()
  await sheet.getByRole('button', { name: '开启定期更新' }).click()
  await expect(page.getByText('已开启定期更新')).toBeVisible()
  // Saving closes the sheet.
  await expect(sheet).toBeHidden()
  expect(sent).toEqual([
    {
      method: 'PUT',
      path: '/v1/watches',
      body: {
        target: 'collection',
        id: profileId,
        every: { count: 6, unit: 'hour' },
        time_zone: await page.evaluate(
          () => new Intl.DateTimeFormat().resolvedOptions().timeZone,
        ),
        options: {
          ...defaults,
          posts: 'until_existing',
          count: undefined,
          relations: true,
        },
      },
    },
  ])
  // The row says how often and when next, in local time.
  await expect(row).toContainText('每 6 小时')
  await expect(row).toContainText('下次 今天 23:05')

  // Editing keeps what was chosen; the last run links to its record.
  setLastRun({
    id: 'run',
    state: 'complete',
    done: true,
    created_at: new Date().toISOString(),
  })
  await row.click()
  await expect(sheet.getByLabel('间隔')).toHaveValue('6')
  await expect(sheet.getByLabel('单位')).toHaveValue('hour')
  await expect(sheet.getByLabel('帖子范围')).toHaveValue('until_existing')
  await expect(sheet.getByLabel('抓关系网')).toBeChecked()
  await expect(sheet.getByText('下次 今天 23:05')).toBeVisible()
  // Every 2 months; too few minutes would be made 5.
  await sheet.getByLabel('单位').selectOption('minute')
  await sheet.getByLabel('间隔').fill('3')
  await sheet.getByLabel('间隔').blur()
  await expect(sheet.getByLabel('间隔')).toHaveValue('5')
  await sheet.getByLabel('单位').selectOption('month')
  await sheet.getByLabel('间隔').fill('2')
  await sheet.getByRole('button', { name: '保存' }).click()
  await expect(sheet).toBeHidden()
  await expect(row).toContainText('每 2 个月')
  expect(sent.at(-1)).toMatchObject({
    method: 'PUT',
    body: { every: { count: 2, unit: 'month' }, options: { relations: true } },
  })
  await row.click()
  await expect(
    sheet.getByRole('link', { name: /^上次 今天 .* · 已完成$/ }),
  ).toHaveAttribute('href', /\/captures\/run$/)
})

test('采集 lists the watches; one can be turned off', async ({ page }) => {
  const { sent } = await serve(page)
  await page.goto(`/collection/${profileId}`)
  await page
    .locator('.section.update')
    .getByRole('button', { name: /^定期更新/ })
    .click()
  await page.getByRole('button', { name: '开启定期更新' }).click()
  await expect(page.getByText('已开启定期更新')).toBeVisible()

  // 采集's second tab.
  await page.goto('/captures')
  await page
    .getByRole('navigation', { name: '采集', exact: true })
    .getByRole('link', { name: '定期更新' })
    .click()
  await expect(page).toHaveURL(/\/captures\/watches$/)
  await expect(page.locator('h1')).toHaveText('采集')
  const item = page.locator('.watch')
  await expect(item.getByRole('link', { name: '@owner' })).toBeVisible()
  await expect(item).toContainText('每天 · 最新 100 条')
  await expect(item).toContainText('下次 今天 23:05')
  await page.getByRole('switch', { name: '开启 @owner 的定期更新' }).click()
  await expect(item).toContainText('已关闭')
  expect(sent.at(-1)).toEqual({
    method: 'PATCH',
    path: '/v1/watches/watch',
    body: { enabled: false },
  })
  // 编辑 opens the same sheet as the profile's page.
  await page.getByRole('button', { name: '编辑 @owner 的定期更新' }).click()
  const sheet = page.getByRole('dialog', { name: '定期更新 @owner' })
  await expect(sheet.getByLabel('间隔')).toHaveValue('1')
  await expect(sheet.getByLabel('单位')).toHaveValue('day')
  await sheet.getByLabel('间隔').fill('2')
  await sheet.getByLabel('单位').selectOption('week')
  await sheet.getByRole('button', { name: '保存' }).click()
  await expect(sheet).toBeHidden()
  await expect(item).toContainText('每 2 周 · 最新 100 条')
})

test('watch a folder from its menu', async ({ page }) => {
  const folderId = '00000000-0000-7000-8000-0000000000c1'
  const folder = {
    id: folderId,
    name: '猫',
    filter: 'q=cat',
    count: 1,
    types: { 'x.profile': 1 },
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z',
  }
  let watch: Record<string, unknown> | undefined
  let sent: unknown
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    let json: unknown = { items: [] }
    switch (path) {
      case '/v1/folders': {
        json = [folder]
        break
      }
      case '/v1/collections/count': {
        json = { count: 1, types: { 'x.profile': 1 } }
        break
      }
      case '/v1/updates/preview': {
        json = { posts: 0, profiles: 1, listable: 1, name: '猫' }
        break
      }
      case '/v1/usage': {
        json = { used_bytes: 0 }
        break
      }
      case '/v1/tags': {
        json = []
        break
      }
      default:
        if (path === '/v1/watches' && request.method() === 'PUT') {
          sent = request.postDataJSON()
          watch = {
            id: 'watch',
            target: 'folder',
            target_id: folderId,
            name: '猫',
            every: (sent as { every: object }).every,
            time_zone: 'UTC',
            options: (sent as { options: object }).options,
            enabled: true,
            next_run_at: new Date().toISOString(),
            created_at: '2026-11-26T00:00:00Z',
          }
          json = watch
        } else if (path === '/v1/watches')
          json = { items: watch ? [watch] : [] }
    }
    return route.fulfill({ json })
  })
  await page.goto(`/folder/${folderId}`)
  await page.getByRole('button', { name: '管理收藏夹' }).click()
  await page.getByRole('menuitem', { name: '定期更新', exact: true }).click()
  const sheet = page.getByRole('dialog', { name: '定期更新 收藏夹「猫」' })
  await expect(sheet.getByLabel('单位')).toHaveValue('day')
  await sheet.getByLabel('单位').selectOption('week')
  await sheet.getByRole('button', { name: '开启定期更新' }).click()
  await expect(sheet).toBeHidden()
  expect(sent).toMatchObject({
    target: 'folder',
    id: folderId,
    every: { count: 1, unit: 'week' },
    options: { posts: 'latest', count: 100, relations: false },
  })
  await page.getByRole('button', { name: '管理收藏夹' }).click()
  await expect(
    page.getByRole('menuitem', { name: '定期更新 · 每周' }),
  ).toBeVisible()
})
