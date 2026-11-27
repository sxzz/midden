import { FOLDER_SLUG, mockDesktop } from './desktop-mock'
import { expect, test, type Page } from './test'

// From 1000px the library's filters are the sidebar's 筛选 card; the query
// box stays in the column, and the two say the same list. Narrower, they
// stay in the column. 帖子 and 账号 are tabs as X's.

const sidebar = (page: Page) =>
  page.getByRole('complementary', { name: '侧栏' })
const card = (page: Page) => sidebar(page).getByRole('region', { name: '筛选' })
const box = (page: Page) => page.locator('main .query .field')
const kindTab = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: '类型' })
    .getByRole('link', { name, exact: true })

test.describe('at 1280px', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('the filters are a card in the sidebar, applied at once and reset', async ({
    page,
  }) => {
    await mockDesktop(page)
    await page.goto('/')
    await expect(page.locator('h1')).toHaveText('收藏库')
    await expect(card(page)).toBeVisible()
    // Not in the column as well.
    await expect(page.locator('main .filters .toggles')).toHaveCount(0)
    await expect(box(page)).toBeVisible()
    // The count is at the card's foot, not in a box of its own.
    await expect(card(page)).toContainText('1,280条')
    await expect(
      sidebar(page).getByRole('region', { name: '结果' }),
    ).toHaveCount(0)
    await expect(
      card(page).getByRole('button', { name: '重置' }),
    ).toBeDisabled()

    // A change applies at once, and the box says it too.
    await card(page)
      .getByRole('radiogroup', { name: '帖子类型' })
      .getByText('引用', { exact: true })
      .click()
    await expect(page).toHaveURL(/post_type=quote/)
    await expect(box(page)).toHaveValue('is:quote')
    await card(page).getByRole('button', { name: '视频', exact: true }).click()
    await expect(page).toHaveURL(/media_type=video/)
    await expect(box(page)).toHaveValue(
      /is:quote.*has:video|has:video.*is:quote/,
    )
    // And the other way: the box's terms move the card's controls.
    await box(page).fill('is:repost')
    await box(page).press('Enter')
    await expect(page).toHaveURL(/post_type=repost/)
    await expect(
      card(page).getByRole('radio', { name: '转发', exact: true }),
    ).toBeChecked()
    await expect(
      card(page).getByRole('button', { name: '视频', exact: true }),
    ).toHaveAttribute('aria-pressed', 'false')

    // It stays in the window as the list scrolls.
    await page.mouse.move(500, 500)
    await page.mouse.wheel(0, 2500)
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBeGreaterThan(1000)
    await expect(card(page)).toBeInViewport()
    const top = (await card(page).boundingBox())!.y
    expect(top).toBeGreaterThanOrEqual(0)
    expect(top).toBeLessThan(40)

    // 重置 clears everything.
    await card(page).getByRole('button', { name: '重置' }).click()
    await expect(page).toHaveURL(/:\d+\/$/)
    await expect(box(page)).toHaveValue('')
    await expect(
      card(page).getByRole('radio', { name: '全部', exact: true }).first(),
    ).toBeChecked()
  })

  test('帖子 and 账号 are tabs, each with its address and its own card', async ({
    page,
  }) => {
    await mockDesktop(page)
    await page.goto('/')
    await expect(kindTab(page, '帖子')).toHaveAttribute('aria-current', 'page')
    await kindTab(page, '账号').click()
    await expect(page).toHaveURL(
      /\/\?entity_type=x\.profile,instagram\.profile$/,
    )
    await expect(kindTab(page, '账号')).toHaveAttribute('aria-current', 'page')
    // An account has no post type to filter by; one card at a time.
    await expect(card(page)).toHaveCount(1)
    await expect(
      card(page).getByRole('radiogroup', { name: '帖子类型' }),
    ).toHaveCount(0)
    await kindTab(page, '帖子').click()
    await expect(page).toHaveURL(/:\d+\/$/)
    await expect(
      card(page).getByRole('radiogroup', { name: '帖子类型' }),
    ).toBeVisible()
  })

  test('a share’s list has the tabs and a public card', async ({ page }) => {
    await mockDesktop(page)
    await page.route(`**/v1/public/${FOLDER_SLUG}`, (r) =>
      r.fulfill({
        json: { target: 'folder', name: '公开的风景', posts: 128, profiles: 3 },
      }),
    )
    await page.goto(`/s/${FOLDER_SLUG}`)
    await expect(page.locator('h1')).toHaveText('公开的风景')
    await expect(kindTab(page, '帖子')).toHaveAttribute('aria-current', 'page')
    await expect(card(page)).toBeVisible()
    // Nothing of the owner's own: tags, save dates, relations.
    await expect(card(page)).not.toContainText('标签')
    await expect(card(page)).not.toContainText('收藏日期')
    await card(page).getByText('更多条件').click()
    await expect(card(page)).not.toContainText('关系')
    await kindTab(page, '账号').click()
    await expect(page).toHaveURL(/entity_type=x\.profile/)
    await expect(kindTab(page, '账号')).toHaveAttribute('aria-current', 'page')
  })
})

test.describe('in a short window', () => {
  test.use({ viewport: { width: 1280, height: 480 } })

  test('a wheel over the card moves it, down to its foot', async ({ page }) => {
    await mockDesktop(page)
    await page.goto('/')
    // Everything set, so 更多条件 is open and the card is at its tallest.
    await page.goto('/?visibility=public&post_type=quote')
    await expect(card(page)).toBeVisible()
    const foot = card(page).getByRole('button', { name: '查询语法' })
    await expect(foot).not.toBeInViewport()
    const before = (await card(page).boundingBox())!.y
    const head = (await card(page).getByRole('heading').boundingBox())!
    await page.mouse.move(head.x + 20, head.y + 120)
    await page.mouse.wheel(0, 200)
    await expect
      .poll(async () => (await card(page).boundingBox())!.y)
      .toBeLessThan(before - 50)
    // Step by step, the foot comes into view on the way down.
    let seen = false
    for (let i = 0; i < 20 && !seen; i++) {
      await page.mouse.wheel(0, 80)
      await page.waitForTimeout(100)
      const box = await foot.boundingBox()
      seen = !!box && box.y >= 0 && box.y + box.height <= 480
    }
    expect(seen).toBe(true)
  })
})

test.describe('at 800px', () => {
  test.use({ viewport: { width: 800, height: 900 } })

  test('the filters stay in the column', async ({ page }) => {
    await mockDesktop(page)
    await page.goto('/')
    await expect(page.locator('h1')).toHaveText('收藏库')
    await expect(sidebar(page)).toHaveCount(0)
    await expect(page.locator('.filter-card')).toHaveCount(0)
    await page.getByRole('button', { name: /^筛选/ }).click()
    await expect(page.getByLabel('帖子类型', { exact: true })).toBeVisible()
    await expect(kindTab(page, '帖子')).toHaveAttribute('aria-current', 'page')
  })
})
