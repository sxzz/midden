import { mockDesktop, PROFILE_ID } from './desktop-mock'
import { expect, test, type Page } from './test'

const rail = (page: Page) => page.getByRole('banner')
const nav = (page: Page) => page.getByRole('navigation', { name: '主导航' })
const item = (page: Page, name: string) =>
  nav(page).getByRole('link', { name, exact: true })
const sidebar = (page: Page) =>
  page.getByRole('complementary', { name: '侧栏' })

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
    // Icons only: the labels wait for 1280px, and so does the sidebar.
    await expect(item(page, '探索')).toBeVisible()
    await expect(item(page, '探索').locator('.label')).toBeHidden()
    await expect(sidebar(page)).toHaveCount(0)
    await expect(item(page, '探索')).toHaveAttribute('aria-current', 'page')
    // The column is 600px between the rail and the window's edge.
    const column = await page.locator('main.page').boundingBox()
    expect(Math.round(column!.width)).toBe(600)
    // A sheet opens in the middle of the window, not at its bottom.
    await page.getByRole('button', { name: '抓取' }).click()
    const sheet = page.getByRole('dialog', { name: '采集链接' })
    await expect(sheet).toBeVisible()
    const box = await sheet.boundingBox()
    expect(box!.y + box!.height).toBeLessThan(900 - 40)
  })

  test('moves between the pages, Cmd-click opening a new tab', async ({
    page,
    context,
  }) => {
    await mockDesktop(page)
    await page.goto('/app/')
    await item(page, '关系').click()
    await expect(page.locator('h1')).toHaveText('关系')
    await expect(item(page, '关系')).toHaveAttribute('aria-current', 'page')
    // 采集 is its own item, lit on its pages instead of 探索.
    await item(page, '采集').click()
    await expect(page.locator('h1')).toHaveText('采集')
    await expect(item(page, '采集')).toHaveAttribute('aria-current', 'page')
    await expect(item(page, '探索')).not.toHaveAttribute('aria-current')
    await item(page, '设置').click()
    await expect(page.locator('h1')).toHaveText('设置')
    await expect(item(page, '设置')).toHaveAttribute('aria-current', 'page')
    // 探索 returns to the page it was left on, 采集.
    await expect(item(page, '探索')).toHaveAttribute('href', '#/captures')
    await item(page, '探索').click()
    await expect(page.locator('h1')).toHaveText('采集')

    const opened = context.waitForEvent('page')
    await item(page, '关系').click({ modifiers: ['ControlOrMeta'] })
    const other = await opened
    await expect(other).toHaveURL(/#\/relations/)
    await other.close()
    await expect(page.locator('h1')).toHaveText('采集')
  })
})

test.describe('from 1280px', () => {
  test.use({ viewport: { width: 1280, height: 900 } })

  test('the rail has labels and the sidebar shows', async ({ page }) => {
    await mockDesktop(page)
    await page.goto('/app/')
    await expect(item(page, '探索').locator('.label')).toBeVisible()
    await expect(item(page, '探索').locator('.label')).toHaveText('探索')
    await expect(rail(page).getByText('抓取')).toBeVisible()
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

  test('抓取 submits links from any page', async ({ page }) => {
    const { captured } = await mockDesktop(page)
    await page.goto(`/app/#/settings`)
    await page.getByRole('button', { name: '抓取' }).click()
    const sheet = page.getByRole('dialog', { name: '采集链接' })
    await sheet
      .getByRole('textbox')
      .fill('https://x.com/a/status/1\nhttps://x.com/b/status/2')
    await sheet.getByRole('button', { name: '采集 2 条' }).click()
    await expect(sheet).toBeHidden()
    await expect(page.getByText('已提交 2 条。')).toBeVisible()
    expect(captured).toEqual([
      'https://x.com/a/status/1',
      'https://x.com/b/status/2',
    ])
    await expect(page.locator('h1')).toHaveText('设置')
  })
})

test('below 700px the phone layout stays', async ({ page }) => {
  await page.setViewportSize({ width: 699, height: 900 })
  await mockDesktop(page)
  await page.goto('/app/')
  await expect(page.locator('h1')).toHaveText('我的收藏')
  await expect(page.locator('[data-tab-bar-nav]')).toBeVisible()
  await expect(rail(page)).toHaveCount(0)
  await expect(sidebar(page)).toHaveCount(0)
  await expect(page.getByRole('button', { name: '抓取' })).toHaveCount(0)
  // 采集 stays in 探索's header there.
  await expect(
    page.getByRole('link', { name: '采集', exact: true }),
  ).toBeVisible()
  // Widening the window swaps the bar for the rail.
  await page.setViewportSize({ width: 1000, height: 900 })
  await expect(rail(page)).toBeVisible()
  await expect(page.locator('[data-tab-bar-nav]')).toHaveCount(0)
})
