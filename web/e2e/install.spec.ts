import { mockDesktop } from './desktop-mock'
import { expect, test, type Page } from './test'

// 设置 → 账号 → 添加到桌面: Chrome's install prompt, or Safari's home
// screen profile on an iPhone; nothing in Telegram or an installed app.
const account = (page: Page) =>
  page.getByRole('region', { name: '账号', exact: true })
const row = (page: Page) =>
  account(page).getByRole('button', { name: /^添加到桌面/ })

/** Chrome's prompt, as the browser sends it, counting what it is asked. */
async function firePrompt(page: Page) {
  await page.evaluate(() => {
    const event = new Event('beforeinstallprompt', { cancelable: true })
    Object.assign(event, {
      prompt: () => {
        const counted = globalThis as unknown as { prompted?: number }
        counted.prompted = (counted.prompted ?? 0) + 1
        return Promise.resolve({ outcome: 'dismissed' })
      },
    })
    dispatchEvent(event)
  })
}
const prompted = (page: Page) =>
  page.evaluate(
    () => (globalThis as unknown as { prompted?: number }).prompted ?? 0,
  )

test("offers Chrome's install prompt once it comes", async ({ page }) => {
  await mockDesktop(page)
  await page.goto('/settings/account')
  await expect(
    account(page).getByRole('button', { name: /^昵称/ }),
  ).toBeVisible()
  await expect(row(page)).toHaveCount(0)
  await firePrompt(page)
  await expect(row(page)).toContainText('在桌面或主屏幕上放一个Midden图标')
  await row(page).click()
  await expect.poll(() => prompted(page)).toBe(1)
  // A prompt is shown once; dismissed, the row waits for the next.
  await expect(row(page)).toHaveCount(0)
})

test('offers nothing in an installed app', async ({ page }) => {
  await page.addInitScript(() => {
    // Opened from the desktop: the window is in standalone display mode.
    const media = matchMedia.bind(globalThis)
    Object.defineProperty(globalThis, 'matchMedia', {
      value: (query: string) =>
        query === '(display-mode: standalone)'
          ? { matches: true, media: query }
          : media(query),
    })
  })
  await mockDesktop(page)
  await page.goto('/settings/account')
  await firePrompt(page)
  await expect(
    account(page).getByRole('button', { name: /^昵称/ }),
  ).toBeVisible()
  await expect(account(page)).not.toContainText('添加到桌面')
})

test('offers nothing inside Telegram', async ({ page }) => {
  await page.addInitScript(() => {
    const noop = () => {}
    Object.assign(globalThis, {
      Telegram: {
        WebApp: {
          initData: 'signed',
          themeParams: {},
          colorScheme: 'light',
          ready: noop,
          expand: noop,
          onEvent: noop,
          offEvent: noop,
          BackButton: { show: noop, hide: noop, onClick: noop, offClick: noop },
        },
      },
    })
  })
  await mockDesktop(page)
  await page.goto('/settings/account')
  await firePrompt(page)
  await expect(
    account(page).getByRole('button', { name: /^昵称/ }),
  ).toBeVisible()
  await expect(account(page)).not.toContainText('添加到桌面')
})

test.describe('in Safari on an iPhone', () => {
  test.use({
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  })

  test('links to the home screen profile', async ({ page }) => {
    await mockDesktop(page)
    await page.goto('/settings/account')
    const link = account(page).getByRole('link', { name: /^添加到桌面/ })
    await expect(link).toContainText('在桌面或主屏幕上放一个Midden图标')
    await expect(link).toHaveAttribute('href', '/midden.mobileconfig')
    const response = await page.request.get((await link.getAttribute('href'))!)
    expect(response.headers()['content-type']).toBe(
      'application/x-apple-aspen-config',
    )
    const profile = await response.text()
    expect(profile).toContain('<string>com.apple.webClip.managed</string>')
    expect(profile).toContain(`<string>${new URL(page.url()).origin}/</string>`)
  })
})
