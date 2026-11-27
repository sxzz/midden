import { FOLDER_SLUG, mockDesktop, PROFILE_ID } from './desktop-mock'
import { expect, test, type Page } from './test'

// 刷新 never has a row of its own: beside the layout switcher where there
// is a toolbar, else in the page's header with its other icons, or at the
// right of the tabs on a page without a header (收藏库, 采集).

/** Each shown 刷新 that sits alone in a row outside the header. */
const alone = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('button[aria-label="刷新"]')]
      .filter((button) => button.getClientRects().length)
      .filter((button) => {
        if (button.closest('header, .page-tabs')) return false
        const row = button.parentElement!
        return [...row.children].every(
          (other) => other === button || !other.getClientRects().length,
        )
      })
      .map((button) => button.parentElement!.className || 'row'),
  )

const pages = [
  ['/', 'main .row'],
  ['/?entity_type=x.profile,instagram.profile', 'main .layout-bar'],
  ['/captures', 'button[aria-label="刷新"]'],
  [`/collection/${PROFILE_ID}/history/follows`, 'button[aria-label="刷新"]'],
  [`/s/${FOLDER_SLUG}`, 'main .row'],
] as const

for (const width of [390, 1280]) {
  test(`no row holds 刷新 alone (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await mockDesktop(page)
    for (const [address, ready] of pages) {
      await page.goto(address)
      await page.locator(ready).first().waitFor()
      await expect(page.getByRole('button', { name: '刷新' })).toHaveCount(1)
      expect(await alone(page), address).toEqual([])
    }
    // 关注 and 采集 have no toolbar: 刷新 is in the header, or at the right
    // of 采集's tabs, which has none.
    await page.goto(`/collection/${PROFILE_ID}/history/follows`)
    await expect(
      page.locator('header').getByRole('button', { name: '刷新' }),
    ).toBeVisible()
    await page.goto('/captures')
    await expect(
      page
        .getByRole('navigation', { name: '采集' })
        .getByRole('button', { name: '刷新' }),
    ).toBeVisible()
  })
}

for (const width of [390, 1280]) {
  test(`收藏库 and 采集 have their tabs and no title (${width}px)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    await mockDesktop(page)
    for (const [address, tabs, title] of [
      ['/', '类型', '收藏库'],
      ['/captures', '采集', '采集'],
      ['/captures/watches', '采集', '采集'],
    ] as const) {
      await page.goto(address)
      const nav = page.getByRole('navigation', { name: tabs }).first()
      await expect(nav).toBeVisible()
      // Named for screen readers, not shown; no header above the tabs.
      const heading = page.getByRole('heading', { level: 1, name: title })
      await expect(heading).toHaveCount(1)
      expect(
        await heading.evaluate((h) => h.getBoundingClientRect().width),
        address,
      ).toBeLessThanOrEqual(1)
      await expect(page.locator('main > header')).toHaveCount(0)
      expect((await nav.boundingBox())!.y, address).toBeLessThan(2)
    }
    // The eye stays, at the right of 收藏库's tabs.
    await page.goto('/')
    await expect(
      page
        .getByRole('navigation', { name: '类型' })
        .first()
        .getByRole('button', { name: '显示敏感内容' }),
    ).toBeVisible()
    // A folder keeps its title.
    await page.goto(`/s/${FOLDER_SLUG}`)
    await expect(page.locator('main h1').first()).toBeVisible()
  })
}
