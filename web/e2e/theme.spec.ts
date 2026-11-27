import { mockDesktop } from './desktop-mock'
import { expect, test, type Page } from './test'

// One toggle between light and dark: following the system until the reader
// picks the other, remembered in this browser (useDark, theme.ts).

const html = (page: Page) => page.locator('html')
const stored = (page: Page) =>
  page.evaluate(() => localStorage.getItem('midden.theme'))
const rail = (page: Page) => page.getByRole('banner')

test.describe('on a desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('the rail flips the theme, and it is kept across a reload', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await mockDesktop(page)
    await page.goto('/app/')
    await expect(page.locator('h1')).toHaveText('收藏库')
    await expect(html(page)).not.toHaveClass(/\bdark\b/)
    await rail(page).getByRole('button', { name: '切换到深色模式' }).click()
    await expect(html(page)).toHaveClass(/\bdark\b/)
    expect(await stored(page)).toBe('dark')
    await expect(page.locator('body')).toHaveCSS(
      'background-color',
      'rgb(18, 18, 18)',
    )
    // Applied before the app runs, so a reload never flashes light.
    await page.reload()
    await expect(html(page)).toHaveClass(/\bdark\b/)
    await expect(
      rail(page).getByRole('button', { name: '切换到浅色模式' }),
    ).toBeVisible()

    // Back to the system's choice: it follows the system again.
    await rail(page).getByRole('button', { name: '切换到浅色模式' }).click()
    await expect(html(page)).not.toHaveClass(/\bdark\b/)
    expect(await stored(page)).toBe('auto')
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(html(page)).toHaveClass(/\bdark\b/)
    await expect(
      rail(page).getByRole('button', { name: '切换到浅色模式' }),
    ).toBeVisible()
    await page.emulateMedia({ colorScheme: 'light' })
    await expect(html(page)).not.toHaveClass(/\bdark\b/)
  })
})

test.describe('sized as its neighbours', () => {
  test.use({ viewport: { width: 1440, height: 800 } })

  test('the rail’s toggle is set as 设置', async ({ page }) => {
    await mockDesktop(page)
    await page.goto('/app/')
    const look = (name: string) =>
      rail(page)
        .getByRole(name === '设置' ? 'link' : 'button', { name })
        .evaluate((el) => {
          const style = getComputedStyle(el)
          const label = getComputedStyle(el.querySelector('.label')!)
          const icon = el.querySelector('svg')!.getBoundingClientRect()
          return [
            style.fontSize,
            style.fontWeight,
            style.lineHeight,
            label.fontSize,
            icon.width,
            el.getBoundingClientRect().height,
          ]
        })
    expect(await look('切换到深色模式')).toEqual(await look('设置'))
  })
})

test('on a phone 设置 has 深色模式', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await mockDesktop(page)
  await page.goto('/app/settings')
  const toggle = page.getByRole('switch', { name: '深色模式' })
  await expect(toggle).not.toBeChecked()
  // A row as the others in the list.
  const size = (row: string) =>
    page
      .locator('.rows .row')
      .filter({ hasText: row })
      .evaluate((el) => [
        getComputedStyle(el.querySelector('.row-label')!).fontSize,
        getComputedStyle(el).minHeight,
      ])
  expect(await size('深色模式')).toEqual(await size('关于'))
  await toggle.click()
  await expect(html(page)).toHaveClass(/\bdark\b/)
  await expect(toggle).toBeChecked()
  await page.reload()
  await expect(html(page)).toHaveClass(/\bdark\b/)
  await expect(page.getByRole('switch', { name: '深色模式' })).toBeChecked()
})

test('inside Telegram there is no toggle: its theme rules', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.emulateMedia({ colorScheme: 'light' })
  await mockDesktop(page)
  await page.route('https://telegram.org/js/telegram-web-app.js', (r) =>
    r.fulfill({
      contentType: 'text/javascript',
      body: `(() => {
        const data = new URLSearchParams(location.hash.slice(1)).get('tgWebAppData') || ''
        const noop = () => {}
        window.Telegram = { WebApp: {
          initData: data, themeParams: {}, colorScheme: 'dark',
          ready: noop, expand: noop, onEvent: noop, offEvent: noop,
          BackButton: { show: noop, hide: noop, onClick: noop, offClick: noop },
        } }
      })()`,
    }),
  )
  await page.route('**/v1/auth/telegram', (r) => r.fulfill({ json: {} }))
  await page.goto('/app/#tgWebAppData=user%3D42%26hash%3Dabc')
  await expect(page.locator('h1')).toHaveText('收藏库')
  await expect(html(page)).toHaveClass(/\bdark\b/)
  await expect(page.getByRole('button', { name: /^切换到/ })).toHaveCount(0)
  await page.goto('/app/settings#tgWebAppData=user%3D42%26hash%3Dabc')
  await expect(page.getByRole('switch', { name: '深色模式' })).toHaveCount(0)
})
