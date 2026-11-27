import { FOLDER_SLUG, mockDesktop, PROFILE_ID } from './desktop-mock'
import { expect, test, type Page } from './test'

// 刷新 never has a row of its own: beside the layout switcher where there
// is a toolbar, else in the page's header with its other icons.

/** Each shown 刷新 that sits alone in a row outside the header. */
const alone = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('button[aria-label="刷新"]')]
      .filter((button) => button.getClientRects().length)
      .filter((button) => {
        if (button.closest('header')) return false
        const row = button.parentElement!
        return [...row.children].every(
          (other) => other === button || !other.getClientRects().length,
        )
      })
      .map((button) => button.parentElement!.className || 'row'),
  )

const pages = [
  ['/app/', 'main .row'],
  ['/app/?entity_type=x.profile,instagram.profile', 'main .layout-bar'],
  ['/app/captures', 'button[aria-label="刷新"]'],
  [
    `/app/collection/${PROFILE_ID}/history/follows`,
    'button[aria-label="刷新"]',
  ],
  [`/app/s/${FOLDER_SLUG}`, 'main .row'],
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
    // 关注 and 采集 have no toolbar: 刷新 is in the header.
    await page.goto(`/app/collection/${PROFILE_ID}/history/follows`)
    await expect(
      page.locator('header').getByRole('button', { name: '刷新' }),
    ).toBeVisible()
    await page.goto('/app/captures')
    await expect(
      page.locator('header').getByRole('button', { name: '刷新' }),
    ).toBeVisible()
  })
}
