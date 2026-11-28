import { mockDesktop } from './desktop-mock'
import { expect, test, type Page } from './test'

// 添加到桌面: Chrome's install prompt, or Safari's home screen profile on an
// iPhone; on a phone a row under 设置's 深色模式, from 700px an icon button
// beside the rail's theme button. Nothing in Telegram or an installed app.
const list = (page: Page) =>
  page.getByRole('navigation', { name: '设置的分区' })
const ADD = { name: '添加到桌面', exact: true }

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

test("on a phone, Chrome's prompt is a row under 深色模式", async ({
  page,
}) => {
  await mockDesktop(page)
  await page.goto('/settings')
  await expect(list(page).getByRole('switch')).toBeVisible()
  await expect(page.getByRole('button', ADD)).toHaveCount(0)
  await firePrompt(page)
  const row = list(page).getByRole('button', ADD)
  await expect(row).toBeVisible()
  // Right under 深色模式, 退出登录 under it.
  await expect(list(page).locator('.theme-row + .install-row')).toHaveText(
    '添加到桌面',
  )
  await expect(list(page).locator('.install-row + .logout')).toHaveCount(1)
  // Not in 账号 any more.
  await list(page).getByRole('link', { name: /账号/ }).click()
  await expect(page.getByRole('button', { name: /^昵称/ })).toBeVisible()
  await expect(page.getByText('添加到桌面')).toHaveCount(0)
  await page.goBack()
  await list(page).getByRole('button', ADD).click()
  await expect.poll(() => prompted(page)).toBe(1)
  // A prompt is shown once; dismissed, the row waits for the next.
  await expect(list(page).getByRole('button', ADD)).toHaveCount(0)
})

test.describe('on a wide window', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test("Chrome's prompt is a button beside the rail's theme button", async ({
    page,
  }) => {
    await mockDesktop(page)
    await page.goto('/settings')
    const rail = page.locator('.rail')
    await expect(rail.getByRole('button', { name: /^切换到/ })).toBeVisible()
    await expect(page.getByRole('button', ADD)).toHaveCount(0)
    await firePrompt(page)
    const button = rail.getByRole('button', ADD)
    await expect(button).toHaveAttribute('title', '添加到桌面')
    // Side by side, the same size.
    const theme = (await rail
      .getByRole('button', { name: /^切换到/ })
      .boundingBox())!
    const box = (await button.boundingBox())!
    expect([box.width, box.height]).toEqual([theme.width, theme.height])
    expect(box.y).toBe(theme.y)
    expect(box.x).toBeGreaterThan(theme.x)
    // Only the rail has it at this width, not 设置's list.
    await expect(list(page).getByText('添加到桌面')).toHaveCount(0)
    await button.click()
    await expect.poll(() => prompted(page)).toBe(1)
    await expect(button).toHaveCount(0)
  })

  test('it fits the rail of icons too', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 900 })
    await mockDesktop(page)
    await page.goto('/settings')
    await firePrompt(page)
    const rail = (await page.locator('.rail').boundingBox())!
    for (const name of [/^切换到/, /^添加到桌面$/]) {
      const box = (await page
        .locator('.rail')
        .getByRole('button', { name })
        .boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(rail.x)
      expect(box.x + box.width).toBeLessThanOrEqual(rail.x + rail.width)
    }
  })
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
  await page.goto('/settings')
  await expect(list(page).getByRole('switch')).toBeVisible()
  await firePrompt(page)
  await expect(
    list(page).getByRole('button', { name: '退出登录' }),
  ).toBeVisible()
  await expect(page.getByText('添加到桌面')).toHaveCount(0)
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
  await page.goto('/settings')
  await expect(list(page).getByRole('link', { name: /关于/ })).toBeVisible()
  await firePrompt(page)
  await expect(list(page).getByRole('link', { name: /账号/ })).toBeVisible()
  await expect(page.getByText('添加到桌面')).toHaveCount(0)
})

test.describe('in Safari on an iPhone', () => {
  test.use({
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  })

  test('links to the home screen profile', async ({ page }) => {
    await mockDesktop(page)
    await page.goto('/settings')
    const link = list(page).getByRole('link', ADD)
    await expect(link).toHaveAttribute('href', '/midden.mobileconfig')
    await expect(list(page).locator('.theme-row + .install-row')).toHaveCount(1)
    const response = await page.request.get((await link.getAttribute('href'))!)
    expect(response.headers()['content-type']).toBe(
      'application/x-apple-aspen-config',
    )
    const profile = await response.text()
    expect(profile).toContain('<string>com.apple.webClip.managed</string>')
    expect(profile).toContain(`<string>${new URL(page.url()).origin}/</string>`)
  })
})
