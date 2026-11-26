import {
  FOLDER_SLUG,
  mockDesktop,
  PROFILE_ID,
  PROFILE_SLUG,
} from './desktop-mock'
import { expect, test, type Page } from './test'

const rail = (page: Page) => page.getByRole('banner')
const nav = (page: Page) => page.getByRole('navigation', { name: '主导航' })
const item = (page: Page, name: string) =>
  nav(page).getByRole('link', { name, exact: true })
const sidebar = (page: Page) =>
  page.getByRole('complementary', { name: '侧栏' })
/** Nothing sticks out past the window's right edge. */
const fits = (page: Page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth <=
      document.documentElement.clientWidth,
  )

test.describe('from 700px', () => {
  test.use({ viewport: { width: 800, height: 900 } })

  test('the rail of icons takes the bottom bar’s place', async ({ page }) => {
    await mockDesktop(page)
    await page.goto('/app/')
    await expect(page.locator('h1')).toHaveText('我的收藏')
    await expect(rail(page)).toBeVisible()
    await expect(page.locator('[data-tab-bar-nav]')).toHaveCount(0)
    expect(
      await page.evaluate(() => document.body.dataset.tabBar),
    ).toBeUndefined()
    // Icons only, and no sidebar before 1000px.
    await expect(item(page, '探索')).toBeVisible()
    await expect(item(page, '探索').locator('.label')).toBeHidden()
    await expect(sidebar(page)).toHaveCount(0)
    await expect(item(page, '探索')).toHaveAttribute('aria-current', 'page')
    // Without a sidebar the header says how many the list holds.
    await expect(page.locator('.subtitle')).toHaveText('1,280 条')
    await expect(rail(page).getByRole('button', { name: '抓取' })).toHaveCount(
      0,
    )
    // The column is 600px between the rail and the window's edge.
    const column = await page.locator('main.page').boundingBox()
    expect(Math.round(column!.width)).toBe(600)
  })

  test('moves between the tabs, Cmd-click opening a new tab', async ({
    page,
    context,
  }) => {
    await mockDesktop(page)
    await page.goto('/app/')
    await page.locator('.row').first().locator('.head').click()
    await expect(page.locator('h1')).toHaveText('帖子')
    await item(page, '关系').click()
    await expect(page.locator('h1')).toHaveText('关系')
    await expect(item(page, '关系')).toHaveAttribute('aria-current', 'page')
    // 采集 is a tab of its own.
    await item(page, '采集').click()
    await expect(page.locator('h1')).toHaveText('采集')
    await expect(item(page, '采集')).toHaveAttribute('aria-current', 'page')
    await expect(item(page, '探索')).not.toHaveAttribute('aria-current')
    // 探索 still returns to the post it was left on, not to 采集.
    await expect(item(page, '探索')).toHaveAttribute('href', /#\/collection\//)
    await item(page, '设置').click()
    await expect(page.locator('h1')).toHaveText('设置')
    await expect(item(page, '采集')).toHaveAttribute('href', '#/captures')
    await item(page, '探索').click()
    await expect(page.locator('h1')).toHaveText('帖子')

    const opened = context.waitForEvent('page')
    await item(page, '关系').click({ modifiers: ['ControlOrMeta'] })
    const other = await opened
    await expect(other).toHaveURL(/#\/relations/)
    await other.close()
    await expect(page.locator('h1')).toHaveText('帖子')
  })
})

test.describe('from 1000px', () => {
  test.use({ viewport: { width: 1000, height: 800 } })

  test('the sidebar sits beside the rail of icons', async ({ page }) => {
    await mockDesktop(page)
    await page.goto('/app/')
    await expect(sidebar(page)).toBeVisible()
    await expect(item(page, '探索').locator('.label')).toBeHidden()
    // The count is the sidebar's now, said once.
    await expect(sidebar(page)).toContainText('1,280 条')
    await expect(page.locator('.subtitle')).toHaveCount(0)
    expect(await fits(page)).toBe(true)
    for (const width of [1024, 1100, 1279]) {
      await page.setViewportSize({ width, height: 800 })
      await expect(sidebar(page)).toBeVisible()
      expect(await fits(page), `at ${width}px`).toBe(true)
      const column = await page.locator('main.page').boundingBox()
      expect(Math.round(column!.width), `at ${width}px`).toBe(600)
    }
  })
})

test.describe('from 1280px', () => {
  test.use({ viewport: { width: 1280, height: 900 } })

  test('the rail has labels and the sidebar shows', async ({ page }) => {
    await mockDesktop(page)
    await page.goto('/app/')
    await expect(item(page, '探索').locator('.label')).toBeVisible()
    await expect(item(page, '探索').locator('.label')).toHaveText('探索')
    await expect(item(page, '采集').locator('.label')).toHaveText('采集')
    await expect(sidebar(page)).toBeVisible()
    // On the library's lists: its folders, and the list's count.
    await expect(
      sidebar(page).getByRole('link', { name: /风景摄影/ }),
    ).toHaveAttribute('href', /#\/folder\//)
    await expect(sidebar(page)).toContainText('1,280 条')
    // The account in use, and its menu.
    await expect(rail(page)).toContainText('@midden_owner')
    await page.getByRole('button', { name: '账号菜单' }).click()
    await expect(page.getByRole('menuitem', { name: '退出登录' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
  })

  test('the sidebar searches the library', async ({ page }) => {
    const { searches } = await mockDesktop(page)
    await page.goto('/app/#/settings')
    // The section's pages, and a search box.
    await expect(
      sidebar(page).getByRole('link', { name: '采集账号' }),
    ).toBeVisible()
    const box = sidebar(page).getByRole('searchbox', { name: '搜索收藏' })
    await box.fill('云海')
    await box.press('Enter')
    await expect(page.locator('h1')).toHaveText('我的收藏')
    await expect(page).toHaveURL(/#\/\?q=%E4%BA%91%E6%B5%B7$/)
    await expect.poll(() => searches).toContain('云海')
    // The list has its own search box, so the sidebar's goes.
    await expect(box).toHaveCount(0)
  })

  test('a profile’s sidebar sums up its relations and captures', async ({
    page,
  }) => {
    await mockDesktop(page)
    await page.goto(`/app/#/collection/${PROFILE_ID}`)
    await expect(page.locator('h1')).toHaveText('账号')
    await expect(page.locator('.subtitle')).toHaveText('@mountain_log')
    const relations = sidebar(page).getByRole('region', { name: '关系网' })
    await expect(relations).toContainText('4,820')
    await expect(relations.getByRole('link', { name: /粉丝/ })).toHaveAttribute(
      'href',
      /rel=followers/,
    )
    const captures = sidebar(page).getByRole('region', { name: '采集信息' })
    await expect(captures).toContainText('3 次')
    await expect(captures).toContainText('173.6 MB')
    await expect(captures).toContainText(/定期更新\s*每天 · 下次/)
    // A graph has the sidebar's room instead.
    await relations.getByRole('link', { name: '关系图谱' }).click()
    await expect(page.locator('h1')).toHaveText('关系图谱')
    await expect(sidebar(page)).toHaveCount(0)
    const column = await page.locator('main.page').boundingBox()
    expect(Math.round(column!.width)).toBe(980)
  })
})

test('below 700px the phone layout stays', async ({ page }) => {
  await page.setViewportSize({ width: 699, height: 900 })
  await mockDesktop(page)
  await page.goto('/app/')
  await expect(page.locator('h1')).toHaveText('我的收藏')
  const bar = page.locator('[data-tab-bar-nav]')
  await expect(bar).toBeVisible()
  await expect(rail(page)).toHaveCount(0)
  await expect(sidebar(page)).toHaveCount(0)
  await expect(page.locator('.subtitle')).toHaveCount(0)
  // 采集 is a tab there too.
  await expect(bar.getByRole('link')).toHaveText([
    '探索',
    '采集',
    '关系',
    '设置',
  ])
  // Widening the window swaps the bar for the rail.
  await page.setViewportSize({ width: 1000, height: 900 })
  await expect(rail(page)).toBeVisible()
  await expect(bar).toHaveCount(0)
})

test.describe('a public link', () => {
  test('keeps its column on a phone', async ({ page }) => {
    await mockDesktop(page)
    await page.goto(`/app/#/s/${FOLDER_SLUG}`)
    await expect(page.locator('h1')).toHaveText('公开的风景')
    await expect(page.locator('.row').first()).toBeVisible()
    await expect(sidebar(page)).toHaveCount(0)
    await expect(rail(page)).toHaveCount(0)
  })

  test('has a column from 700px and a sidebar from 1000px, no rail', async ({
    page,
  }) => {
    const { searches } = await mockDesktop(page)
    await page.setViewportSize({ width: 800, height: 900 })
    await page.goto(`/app/#/s/${FOLDER_SLUG}`)
    await expect(page.locator('h1')).toHaveText('公开的风景')
    const column = await page.locator('main.page').boundingBox()
    expect(Math.round(column!.width)).toBe(600)
    await expect(sidebar(page)).toHaveCount(0)
    await page.setViewportSize({ width: 1280, height: 900 })
    await expect(sidebar(page)).toBeVisible()
    await expect(rail(page)).toHaveCount(0)
    await expect(nav(page)).toHaveCount(0)
    const shared = sidebar(page).getByRole('region', { name: '公开分享' })
    await expect(shared).toContainText('公开的风景')
    await expect(shared).toContainText('128 条帖子')
    // The folder's list has its own search box; below it, the sidebar's.
    await expect(sidebar(page).getByRole('searchbox')).toHaveCount(0)
    await page.locator('.row').first().locator('.head').click()
    await expect(page.locator('h1')).toHaveText('帖子')
    await expect(shared.getByRole('link', { name: '分享首页' })).toBeVisible()
    const box = sidebar(page).getByRole('searchbox', { name: '在分享中搜索' })
    await box.fill('湖')
    await box.press('Enter')
    await expect(page).toHaveURL(
      new RegExp(String.raw`#/s/${FOLDER_SLUG}\?q=%E6%B9%96$`),
    )
    await expect.poll(() => searches).toContain('湖')
    expect(await fits(page)).toBe(true)
  })

  test('sums up a shared account without leaving the share', async ({
    page,
  }) => {
    await mockDesktop(page)
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto(`/app/#/s/${PROFILE_SLUG}`)
    await expect(page.locator('h1')).toHaveText('账号')
    const shared = sidebar(page).getByRole('region', { name: '公开分享' })
    await expect(shared).toContainText('山野记录')
    await expect(shared).toContainText('@mountain_log')
    const relations = sidebar(page).getByRole('region', { name: '关系网' })
    await expect(relations).toContainText('4,820')
    // The counts are no links into the owner's library, and every link
    // stays within the share.
    await expect(relations.getByRole('link', { name: /粉丝/ })).toHaveCount(0)
    const links = await sidebar(page)
      .locator('a[href^="#"]')
      .evaluateAll((all) => all.map((a) => a.getAttribute('href')))
    expect(links.length).toBeGreaterThan(0)
    for (const href of links) expect(href).toMatch(/^#\/s\//)
  })
})
