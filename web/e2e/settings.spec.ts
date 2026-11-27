import { mockDesktop } from './desktop-mock'
import { expect, test, type Page } from './test'

// 设置 as X's: the list of sections, a section with its entries, an entry.
const list = (page: Page) =>
  page.getByRole('navigation', { name: '设置的分区' })
const pane = (page: Page, name: string) =>
  page.getByRole('region', { name, exact: true })

test.describe('on a wide window', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('shows the list beside the chosen section', async ({ page }) => {
    await mockDesktop(page)
    await page.goto('/settings')
    // The first section is chosen until another is.
    await expect(
      page.getByRole('heading', { name: '设置', exact: true }),
    ).toBeVisible()
    await expect(list(page).getByRole('link')).toHaveText([
      /通行密钥/,
      /API令牌/,
      /管理员面板/,
      /关于/,
    ])
    await expect(
      list(page).getByRole('link', { name: /通行密钥/ }),
    ).toHaveAttribute('aria-current', 'page')
    await expect(pane(page, '通行密钥')).toContainText(
      '在浏览器中登录用的通行密钥。',
    )
    // No sidebar: the chosen section takes its room.
    await expect(page.getByRole('complementary')).toHaveCount(0)

    await list(page)
      .getByRole('link', { name: /管理员面板/ })
      .click()
    await expect(page).toHaveURL(/\/settings\/admin$/)
    const admin = pane(page, '管理员面板')
    await expect(admin).toContainText('整个服务的设置。')
    await expect(admin.getByRole('link', { name: /^后台任务/ })).toContainText(
      '队列、暂停与限流',
    )
    // An entry shows in the same place, with a way back to its section.
    await admin.getByRole('link', { name: /^后台任务/ }).click()
    await expect(page).toHaveURL(/\/settings\/admin\/jobs$/)
    const jobs = pane(page, '后台任务')
    await expect(jobs).toContainText('暂停全部')
    await expect(
      list(page).getByRole('link', { name: /管理员面板/ }),
    ).toHaveAttribute('aria-current', 'page')
    await jobs.getByRole('link', { name: '返回管理员面板' }).click()
    await expect(page).toHaveURL(/\/settings\/admin$/)
  })

  test('opens what a link names', async ({ page }) => {
    await mockDesktop(page)
    await page.goto('/settings/admin/origins')
    await expect(pane(page, '域名')).toContainText('添加域名')
    await expect(
      list(page).getByRole('link', { name: /管理员面板/ }),
    ).toHaveAttribute('aria-current', 'page')
    await page.goto('/settings/about')
    await expect(pane(page, '关于')).toContainText('构建时间')
    await expect(
      pane(page, '关于').getByRole('link', { name: /源代码/ }),
    ).toHaveAttribute('href', 'https://github.com/sxzz/midden')
  })

  test('searches its sections and entries', async ({ page }) => {
    await mockDesktop(page)
    await page.goto('/settings')
    const search = page.getByRole('searchbox', { name: '搜索设置' })
    await search.fill('空间')
    // Found by the line under it, under the section it belongs to.
    await expect(list(page).getByRole('link')).toHaveCount(1)
    await expect(list(page).getByRole('link')).toContainText('管理员面板 ·')
    await search.fill('令牌')
    await expect(list(page).getByRole('link')).toHaveCount(1)
    await expect(list(page).locator('mark')).toHaveText('令牌')
    await search.fill('没有这一项')
    await expect(list(page)).toContainText('没有找到「没有这一项」')
    await search.fill('')
    await expect(list(page).getByRole('link')).toHaveCount(4)
  })

  test('reads 后台任务 only while it is shown', async ({ page }) => {
    await mockDesktop(page)
    let polls = 0
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/v1/queue') polls++
    })
    await page.goto('/settings/admin/jobs')
    await expect(pane(page, '后台任务')).toContainText('暂停全部')
    await expect.poll(() => polls).toBeGreaterThan(0)
    await page
      .getByRole('region', { name: '后台任务' })
      .getByRole('link', { name: '返回管理员面板' })
      .click()
    await expect(page).toHaveURL(/\/settings\/admin$/)
    const after = polls
    // It reads again every 5 seconds while open.
    await page.waitForTimeout(6000)
    expect(polls).toBe(after)
  })
})

test('on a phone, each level is a page of its own', async ({ page }) => {
  await mockDesktop(page)
  await page.goto('/settings')
  await expect(page.locator('h1')).toHaveText('设置')
  await expect(page.getByRole('region', { name: '管理员面板' })).toHaveCount(0)
  await list(page)
    .getByRole('link', { name: /管理员面板/ })
    .click()
  await expect(page).toHaveURL(/\/settings\/admin$/)
  await expect(page.locator('h1')).toHaveText('管理员面板')
  await expect(list(page)).toHaveCount(0)
  await pane(page, '管理员面板').getByRole('link', { name: /^域名/ }).click()
  await expect(page).toHaveURL(/\/settings\/admin\/origins$/)
  await expect(page.locator('h1')).toHaveText('域名')
  await expect(pane(page, '域名')).toContainText('添加域名')
  // 返回 climbs back one level at a time.
  await page.getByRole('link', { name: '返回', exact: true }).click()
  await expect(page.locator('h1')).toHaveText('管理员面板')
  await page.getByRole('link', { name: '返回', exact: true }).click()
  await expect(page.locator('h1')).toHaveText('设置')
  await expect(page.getByRole('button', { name: '退出登录' })).toBeVisible()
})
