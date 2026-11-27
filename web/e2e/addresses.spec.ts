import { FOLDER_SLUG, mockDesktop } from './desktop-mock'
import { expect, test } from './test'

// The app's addresses are plain paths under /; old hash addresses
// (/#/…) lead to them.

test('a deep link loads its page directly', async ({ page }) => {
  await mockDesktop(page)
  for (const [address, title] of [
    ['/settings/admin/jobs', '后台任务'],
    ['/captures/watches', '采集'],
    ['/relations', '关系'],
  ] as const) {
    await page.goto(address)
    await expect(page.locator('h1')).toHaveText(title)
    expect(new URL(page.url()).pathname).toBe(address)
  }
  // Links are plain paths too, so a new tab opens the same.
  await expect(
    page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('link', { name: '设置' }),
  ).toHaveAttribute('href', '/settings/admin/jobs')
})

test('an old hash address leads to its plain one', async ({ page }) => {
  await mockDesktop(page)
  await page.goto('/#/captures/watches?dialog=accounts')
  await expect(page).toHaveURL('/captures/watches?dialog=accounts')
  await expect(page.getByRole('dialog', { name: '采集账号' })).toBeVisible()
  // Replaced, not added: back leaves the app.
  expect(await page.evaluate(() => history.length)).toBe(2)
  await page.goto('/#/')
  await expect(page).toHaveURL('/')
  await expect(page.locator('h1')).toHaveText('我的收藏')
})

test('an old public link leads to the share, without Telegram', async ({
  page,
}) => {
  await mockDesktop(page)
  const telegram: string[] = []
  page.on('request', (r) => {
    if (r.url().startsWith('https://telegram.org/')) telegram.push(r.url())
  })
  await page.goto(`/#/s/${FOLDER_SLUG}?q=%E6%B9%96`)
  await expect(page).toHaveURL(`/s/${FOLDER_SLUG}?q=%E6%B9%96`)
  await expect(page.locator('h1')).toHaveText('公开的风景')
  expect(telegram).toEqual([])
})

test('a passkey link keeps its token in the fragment', async ({ page }) => {
  const token = 'a'.repeat(43)
  const seen: string[] = []
  page.on('request', (r) => seen.push(r.url()))
  await page.route('**/v1/**', (r) => r.fulfill({ json: {} }))
  // The old form, as old bot messages hold it, and the new one.
  for (const address of [`/#/passkey/${token}`, `/passkey#${token}`]) {
    await page.goto(address)
    await expect(page).toHaveURL(`/passkey#${token}`)
    await expect(page.locator('h1')).toHaveText('添加通行密钥')
  }
  // Never in a request's address, so never in a server's log.
  expect(seen.filter((url) => url.includes(token))).toEqual([])
})

test('the Mini App’s launch data is no route', async ({ page }) => {
  await page.route('https://telegram.org/js/telegram-web-app.js', (r) =>
    r.fulfill({
      contentType: 'text/javascript',
      body: `(() => {
        const data = new URLSearchParams(location.hash.slice(1)).get('tgWebAppData') || ''
        const noop = () => {}
        window.Telegram = { WebApp: {
          initData: data, themeParams: {},
          ready: noop, expand: noop, onEvent: noop, offEvent: noop,
          BackButton: { show: noop, hide: noop, onClick: noop, offClick: noop },
        } }
      })()`,
    }),
  )
  await mockDesktop(page)
  await page.goto(
    '/captures?dialog=accounts#tgWebAppData=user%3D42%26hash%3Dabc',
  )
  await expect(page.locator('h1')).toHaveText('采集')
  await expect(page.getByRole('dialog', { name: '采集账号' })).toBeVisible()
  expect(new URL(page.url()).pathname).toBe('/captures')
})
