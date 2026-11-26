import { expect, test, type Page } from './test'

const items = Array.from({ length: 40 }, (_, index) => ({
  id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
  text: `收藏 ${index}`,
  author_name: `作者 ${index}`,
  url: 'https://example.test/post',
  saved_at: '2026-09-29T10:00:00Z',
  observed_at: '2026-09-29T10:00:00Z',
  revision_id: 'r1',
  assets: [],
}))
// The first post is long enough for its page to scroll.
items[0]!.text = Array.from(
  { length: 60 },
  (_, line) => `第 ${line + 1} 段：一段足够长的正文。`,
).join('\n\n')
const PROFILE_ID = '22222222-2222-4222-8222-222222222222'
const profile = {
  ...items[1]!,
  id: PROFILE_ID,
  text: '',
  author_name: '账号',
  url: 'https://x.com/someone',
  graph: {
    root: 'x/x.profile/7',
    entities: [
      {
        key: 'x/x.profile/7',
        type: 'x.profile',
        external_id: '7',
        data: { name: '某人', username: 'someone', metadata: {} },
      },
    ],
    relations: [],
  },
}
const OWN = 'x/x.profile/1'
const OTHER = 'x/x.profile/2'
const graphOf = (key: string) => ({
  nodes: [
    { entity_id: 'c', key, external_id: key.slice(-1), name: `中心 ${key}` },
    {
      entity_id: 'f',
      key: 'x/x.profile/9',
      external_id: '9',
      name: '朋友',
      kind: 'mutual',
    },
  ],
  edges: [],
  total: 1,
  kinds: { following: 0, followers: 0, mutual: 1 },
  lists: { following: {}, followers: {} },
})

async function mock(page: Page, perspectives = [OWN, OTHER]) {
  const graphs: string[] = []
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (r) => {
    const url = new URL(r.request().url())
    const path = url.pathname
    if (path === '/v1/collections') return r.fulfill({ json: { items } })
    if (path === '/v1/collections/perspectives')
      return r.fulfill({
        json: {
          items: perspectives.map((id, i) => ({
            id,
            username: i ? 'friend' : 'me',
            following: {},
            followers: {},
            ...(i ? {} : { own: true }),
          })),
        },
      })
    if (path === '/v1/collections/graph') {
      const of = url.searchParams.get('of')!
      graphs.push(of)
      return r.fulfill({ json: graphOf(of) })
    }
    if (path === '/v1/instance')
      return r.fulfill({ json: { dev: false, litestream: { enabled: false } } })
    if (path === '/v1/accounts')
      return r.fulfill({ json: { platforms: [], accounts: [] } })
    const item = [...items, profile].find(
      (i) => path === `/v1/collections/${i.id}`,
    )
    if (item) return r.fulfill({ json: item })
    return r.fulfill({
      json: path.endsWith('/availability')
        ? { available: true }
        : path.endsWith('/origins') ||
            path.endsWith('/passkeys') ||
            path.endsWith('/tokens')
          ? []
          : { items: [] },
    })
  })
  return graphs
}
const bar = (page: Page) => page.getByRole('navigation', { name: '主导航' })
const tab = (page: Page, name: string) =>
  bar(page).getByRole('link', { name, exact: true })
const shown = (page: Page) =>
  expect
    .poll(() => page.evaluate(() => document.body.dataset.tabBar))
    .toBe('shown')
const hidden = (page: Page) =>
  expect
    .poll(() => page.evaluate(() => document.body.dataset.tabBar))
    .toBe('hidden')

test('moves between the three tabs, lighting the one shown', async ({
  page,
}) => {
  const graphs = await mock(page)
  await page.goto('/app/')
  await expect(page.locator('h1')).toHaveText('我的收藏')
  await expect(tab(page, '探索')).toHaveAttribute('aria-current', 'page')
  await expect(tab(page, '探索')).toHaveAttribute('href', '#/')
  // The top bar no longer carries what the bottom one does.
  await expect(page.getByRole('link', { name: '采集账号' })).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Home' })).toHaveCount(0)
  // Capturing is a tab of its own, so the top bar no longer carries it.
  await expect(tab(page, '采集')).toHaveAttribute('href', '#/captures')
  await expect(
    page.locator('.bar').getByRole('link', { name: '采集' }),
  ).toHaveCount(0)

  // 关系 opens on the owner's own account.
  await tab(page, '关系').click()
  await expect(page.locator('h1')).toHaveText('关系')
  await expect(page).toHaveURL(/#\/relations\?of=x\/x\.profile\/1$/)
  await expect(tab(page, '关系')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('button', { name: /互关/ })).toBeVisible()
  expect(graphs).toEqual([OWN])
  // Another centre from the picker.
  await page.getByRole('group', { name: '显示方式' }).waitFor()
  await page.locator('summary', { hasText: '中心' }).click()
  await page.getByRole('option', { name: /friend/ }).click()
  await expect(page).toHaveURL(/#\/relations\?of=x\/x\.profile\/2$/)
  await expect.poll(() => graphs.at(-1)).toBe(OTHER)

  await tab(page, '设置').click()
  await expect(page.locator('h1')).toHaveText('设置')
  await expect(tab(page, '设置')).toHaveAttribute('aria-current', 'page')
  await page.getByRole('link', { name: '采集账号' }).click()
  await expect(page.locator('h1')).toHaveText('采集账号')
  // A page below a tab keeps it lit; tapping it goes back to its root.
  await expect(tab(page, '设置')).toHaveAttribute('aria-current', 'page')
  await tab(page, '设置').click()
  await expect(page.locator('h1')).toHaveText('设置')

  // 关系 returns to the account it was left on.
  await expect(tab(page, '关系')).toHaveAttribute(
    'href',
    '#/relations?of=x/x.profile/2',
  )
  await tab(page, '探索').click()
  await expect(page.locator('h1')).toHaveText('我的收藏')
  await page.locator('.row').first().locator('.head').click()
  await expect(page.locator('h1')).toHaveText('帖子')
  await expect(tab(page, '探索')).toHaveAttribute('aria-current', 'page')
  await tab(page, '探索').click()
  await expect(page.locator('h1')).toHaveText('我的收藏')
})

test('hides on scrolling down and returns on scrolling up', async ({
  page,
}) => {
  await mock(page)
  await page.goto('/app/')
  await expect(page.locator('.row')).toHaveCount(40)
  await shown(page)
  await page.mouse.move(195, 400)
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, 200)
  await hidden(page)
  await expect(bar(page)).toHaveCSS('opacity', '0')
  await page.mouse.wheel(0, -120)
  await shown(page)
  await expect(bar(page)).toHaveCSS('opacity', '1')
  // Tapping the open tab on its root goes back to the top.
  await page.mouse.wheel(0, 400)
  await page.mouse.wheel(0, -60)
  await shown(page)
  await tab(page, '探索').click()
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
  await expect(page).toHaveURL(/#\/$/)
  // The list ends above the bar, not behind it.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  await shown(page)
  const last = await page.locator('.row').last().boundingBox()
  const top = await bar(page).boundingBox()
  expect(last!.y + last!.height).toBeLessThanOrEqual(top!.y)
})

test('gives way to the 多选 bar', async ({ page }) => {
  await mock(page)
  await page.goto('/app/')
  await page.getByRole('button', { name: '多选' }).click()
  await hidden(page)
  await expect(page.getByRole('region', { name: '多选' })).toBeVisible()
  await page
    .getByRole('region', { name: '多选' })
    .getByRole('button', { name: '取消' })
    .click()
  await shown(page)
})

test('each tab opens in a new tab with Cmd or Ctrl', async ({
  page,
  context,
}) => {
  await mock(page)
  await page.goto('/app/')
  await expect(page.locator('h1')).toHaveText('我的收藏')
  const opened = context.waitForEvent('page')
  await tab(page, '设置').click({ modifiers: ['ControlOrMeta'] })
  const other = await opened
  await expect(other).toHaveURL(/#\/settings$/)
  await other.close()
  // This page stays where it was.
  await expect(page).toHaveURL(/#\/$/)
  await expect(page.locator('h1')).toHaveText('我的收藏')
})

test('关系 shows only the picker without relation data', async ({ page }) => {
  const graphs = await mock(page, [])
  await page.goto('/app/#/relations')
  await expect(page.locator('h1')).toHaveText('关系')
  await expect(page.locator('summary', { hasText: '中心' })).toBeVisible()
  await expect(page).toHaveURL(/#\/relations$/)
  await expect(page.locator('.graph-page')).toHaveCount(0)
  expect(graphs).toEqual([])
})

test('a public link has no bottom bar', async ({ page }) => {
  await page.route('**/v1/public/**', (r) =>
    r.fulfill({
      json: r.request().url().includes('/collections')
        ? { items: [] }
        : { target: 'folder', name: '公开收藏夹', posts: 0, profiles: 0 },
    }),
  )
  await page.goto('/app/#/s/AbCdEfGhIjKlMnOpQrStUv_-')
  await expect(page.getByText('公开收藏夹').first()).toBeVisible()
  await expect(page.getByRole('navigation', { name: '主导航' })).toHaveCount(0)
  expect(
    await page.evaluate(() => document.body.dataset.tabBar),
  ).toBeUndefined()
})

const scrollY = (page: Page) => page.evaluate(() => Math.round(window.scrollY))

test('each tab returns to the page and scroll it was left on', async ({
  page,
}) => {
  await mock(page)
  await page.goto('/app/')
  await page.locator('.row').first().locator('.head').click()
  await expect(page.locator('h1')).toHaveText('帖子')
  const detail = page.url()
  await page.evaluate(() =>
    window.scrollTo(0, (document.body.scrollHeight - innerHeight) / 2),
  )
  const left = await scrollY(page)
  expect(left).toBeGreaterThan(300)
  // Switching away and back: the same post, at the same place.
  await expect(tab(page, '探索')).toHaveAttribute('href', '#/')
  await tab(page, '设置').click()
  await expect(page.locator('h1')).toHaveText('设置')
  await page.getByRole('link', { name: '采集账号' }).click()
  await expect(page.locator('h1')).toHaveText('采集账号')
  await expect(tab(page, '探索')).toHaveAttribute(
    'href',
    `#/collection/${items[0]!.id}`,
  )
  await tab(page, '探索').click()
  await expect(page).toHaveURL(detail)
  await expect(page.locator('h1')).toHaveText('帖子')
  await expect.poll(() => scrollY(page)).toBe(left)
  // 设置 kept its sub-page too.
  await expect(tab(page, '设置')).toHaveAttribute('href', '#/settings/accounts')
  // A reload keeps every tab where it was.
  await page.reload()
  await expect(page.locator('h1')).toHaveText('帖子')
  await expect.poll(() => scrollY(page)).toBe(left)
  await expect(tab(page, '设置')).toHaveAttribute('href', '#/settings/accounts')
  // 返回 goes where it would have without the detour: 探索's list. The
  // browser's back still returns to 设置.
  await expect(
    page.getByRole('link', { name: '返回', exact: true }),
  ).toHaveAttribute('href', '#/')
  await page.getByRole('link', { name: '返回', exact: true }).click()
  await expect(page.locator('h1')).toHaveText('我的收藏')
  await page.goBack()
  await expect(page.locator('h1')).toHaveText('采集账号')
})

test('the open tab, tapped, goes to its root, then to the top', async ({
  page,
}) => {
  await mock(page)
  await page.goto('/app/')
  await page.locator('.row').nth(5).locator('.head').click()
  await expect(page.locator('h1')).toHaveText('帖子')
  await tab(page, '探索').click()
  await expect(page.locator('h1')).toHaveText('我的收藏')
  await expect(page).toHaveURL(/#\/$/)
  await page.mouse.move(195, 400)
  await page.mouse.wheel(0, 600)
  await expect.poll(() => scrollY(page)).toBeGreaterThan(0)
  await page.mouse.wheel(0, -60)
  await shown(page)
  await tab(page, '探索').click()
  await expect.poll(() => scrollY(page)).toBe(0)
})

test('titles a post and an account by what they are', async ({ page }) => {
  await mock(page)
  await page.goto(`/app/#/collection/${items[0]!.id}`)
  await expect(page.locator('h1')).toHaveText('帖子')
  await expect(page).toHaveTitle('帖子 · Midden')
  await page.goto(`/app/#/collection/${PROFILE_ID}`)
  await expect(page.locator('h1')).toHaveText('账号')
  await expect(page).toHaveTitle('账号 · Midden')
  await page.goto('/app/#/settings')
  await expect(page).toHaveTitle('设置 · Midden')
})
