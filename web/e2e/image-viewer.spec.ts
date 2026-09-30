import { expect, test } from '@playwright/test'
import { swipeImage } from './touch'

const collection = {
  id: '11111111-1111-4111-8111-111111111111',
  url: 'https://example.test/photo',
  text: '相册交互测试',
  author_name: '相册测试',
  observed_at: '2026-09-30T10:00:00Z',
  visibility: 'public',
  revision_id: 'r1',
  graph: {
    root: 'post',
    entities: [
      { key: 'post', type: 'x.post', data: {} },
      {
        key: 'author',
        type: 'x.profile',
        data: {},
        assets: [
          {
            id: 'avatar',
            purpose: 'avatar',
            state: 'ready',
            mime: 'image/png',
            sensitive: false,
          },
        ],
      },
    ],
    relations: [{ source: 'post', target: 'author', type: 'authored_by' }],
  },
  assets: Array.from({ length: 3 }, (_, i) => ({
    id: `photo-${i}`,
    state: 'ready',
    mime: 'image/png',
    sensitive: false,
    alt_text: `风景 ${i + 1}`,
  })),
}

test.beforeEach(async ({ page }) => {
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (r) => {
    const path = new URL(r.request().url()).pathname
    if (path.startsWith('/v1/assets/'))
      return r.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200"><defs><linearGradient id="s" x2="0" y2="1"><stop stop-color="#234459"/><stop offset=".6" stop-color="#dbb7a1"/><stop offset="1" stop-color="#edcf9f"/></linearGradient></defs><path fill="url(#s)" d="M0 0h900v1200H0z"/><circle cx="660" cy="450" r="90" fill="#ffe6af"/><path d="M0 790 290 430 630 790 900 650v550H0" fill="#405861"/><path d="M0 870 390 665 900 1060v140H0" fill="#1f3843"/><path d="M0 1050 600 890 900 1050v150H0" fill="#102833"/></svg>',
      })
    const body =
      path === '/v1/session'
        ? {}
        : path.endsWith('/availability')
          ? { available: true }
          : path.endsWith('/revisions')
            ? { items: [{ id: 'r1', created_at: collection.observed_at }] }
            : path === `/v1/collections/${collection.id}`
              ? collection
              : path === '/v1/usage'
                ? { used_bytes: 0, reserved_bytes: 0, limit_bytes: 1000 }
                : { items: [collection] }
    return r.fulfill({ json: body })
  })
  await page.goto('/app/')
  await page.getByRole('button', { name: /相册测试/ }).click()
  await page.getByRole('button', { name: '放大图片' }).first().click()
})

test('icon controls, keyboard navigation and native image context menu', async ({
  page,
}) => {
  const dialog = page.getByRole('dialog')
  const next = dialog.getByRole('button', { name: '下一张' })
  await expect(next.locator('svg')).toBeVisible()
  await expect(
    dialog.getByRole('button', { name: '关闭图片' }).locator('svg'),
  ).toBeVisible()
  const img = dialog.getByAltText('风景 1')
  await expect(img).toHaveCSS('opacity', '1')
  const nativeMenuAllowed = await img.evaluate((element) =>
    element.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
    ),
  )
  expect(nativeMenuAllowed).toBe(true)
  await next.click()
  await expect(dialog.getByRole('status').first()).toHaveText('2 / 3')
  await page.keyboard.press('ArrowRight')
  await expect(dialog.getByRole('status').first()).toHaveText('3 / 3')
  await expect(next).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: '放大图片' }).first(),
  ).toBeFocused()
})

test('touch swipe animates and long press keeps the current image', async ({
  page,
}) => {
  await expect(page.locator('.pswp')).toHaveCSS('opacity', '1')
  const client = await page.context().newCDPSession(page)
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: 200, y: 350 }],
  })
  await page.waitForTimeout(600) // Real long-press duration without movement.
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  })
  await client.detach()
  await expect(page.getByRole('dialog').getByRole('status')).toHaveText('1 / 3')
  await swipeImage(page)
  await expect(page.getByRole('dialog').getByRole('status')).toHaveText('2 / 3')
  await expect(page.getByRole('dialog').getByAltText('风景 2')).toBeVisible()
  await page.screenshot({ path: 'test-results/glass-viewer-mobile.png' })
})

test('reduced motion keeps button navigation immediate', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByRole('dialog').getByRole('button', { name: '下一张' }).click()
  await expect(page.getByRole('dialog').getByRole('status')).toHaveText('2 / 3')
  await expect(page.locator('.dot').first()).toHaveCSS(
    'transition-property',
    'none',
  )
})

test('save sends the selected image to Telegram native download', async ({
  page,
}) => {
  const requested: string[] = []
  await page.route('**/v1/assets/*/download', (route) => {
    requested.push(route.request().url())
    return route.fulfill({
      json: {
        url: 'https://example.test/v1/downloads/signed',
        file_name: 'photo-1.png',
      },
    })
  })
  await page.evaluate(() => {
    Object.assign(globalThis, {
      Telegram: {
        WebApp: {
          initData: 'fixture',
          isVersionAtLeast: () => true,
          downloadFile: (params: unknown) => {
            document.body.dataset.download = JSON.stringify(params)
          },
        },
      },
    })
  })
  await page.getByRole('button', { name: '下一张' }).click()
  await expect(page.getByRole('dialog').getByRole('status')).toHaveText('2 / 3')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('body')).toHaveAttribute(
    'data-download',
    JSON.stringify({
      url: 'https://example.test/v1/downloads/signed',
      file_name: 'photo-1.png',
    }),
  )
  expect(requested[0]).toContain('/assets/photo-1/download')
})

test('save reports preparation failures and can retry', async ({ page }) => {
  await page.evaluate(() => {
    Object.assign(globalThis, {
      Telegram: {
        WebApp: {
          initData: 'fixture',
          isVersionAtLeast: () => true,
          downloadFile: () => {},
        },
      },
    })
  })
  await page.route('**/v1/assets/*/download', (route) =>
    route.fulfill({ status: 401, json: {} }),
  )
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('会话已失效')
  await expect(
    page.getByRole('button', { name: '保存', exact: true }),
  ).toBeEnabled()
})

test('opens the clicked list image without navigating and restores focus', async ({
  page,
}) => {
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('button', { name: '返回' }).click()
  const thumbnail = page.getByRole('button', { name: '放大图片' }).nth(1)
  const url = page.url()
  await thumbnail.click()
  await expect(page.getByRole('dialog').getByRole('status')).toHaveText('2 / 3')
  await page.getByRole('dialog').getByRole('button', { name: '下一张' }).click()
  await expect(page.getByRole('dialog').getByRole('status')).toHaveText('3 / 3')
  expect(page.url()).toBe(url)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(thumbnail).toBeFocused()
  expect(page.url()).toBe(url)
})

test('detail avatar opens its own preview and returns focus on close', async ({
  page,
}) => {
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const url = page.url()
  const avatar = page.getByRole('button', { name: '查看相册测试的头像' })
  await avatar.click()
  const dialog = page.getByRole('dialog', { name: '图片预览' })
  await expect(dialog.locator('.pswp__img').last()).toHaveAttribute(
    'src',
    '/v1/assets/avatar?inline=1',
  )
  await expect(dialog.getByRole('button', { name: '下一张' })).toHaveCount(0)
  await dialog.getByRole('button', { name: '关闭图片' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(avatar).toBeFocused()
  expect(page.url()).toBe(url)
})
