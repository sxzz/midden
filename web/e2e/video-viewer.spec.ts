import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

const collection = {
  id: '11111111-1111-4111-8111-111111111111',
  text: '混合媒体',
  author_name: '视频作者',
  url: 'https://example.test/video',
  revision_id: 'r1',
  assets: [
    { id: 'clip', mime: 'video/webm', state: 'ready', alt_text: '测试视频' },
    { id: 'photo', mime: 'image/png', state: 'ready', alt_text: '测试图片' },
  ],
}

test.beforeEach(async ({ page }) => {
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (r) => {
    const path = new URL(r.request().url()).pathname
    if (path === '/v1/assets/clip')
      return r.fulfill({
        path: fileURLToPath(new URL('fixtures/preview.webm', import.meta.url)),
        contentType: 'video/webm',
      })
    if (path === '/v1/assets/photo')
      return r.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><path fill="red" d="M0 0h100v100H0z"/></svg>',
      })
    return r.fulfill({
      json: path.endsWith('/availability')
        ? { available: true }
        : path.endsWith('/revisions')
          ? { items: [] }
          : path === `/v1/collections/${collection.id}`
            ? collection
            : path === '/v1/collections'
              ? { items: [collection] }
              : {},
    })
  })
  await page.goto('/app/')
})

for (const entry of ['list', 'detail']) {
  test(`${entry} video opens in shared preview and pauses on navigation and close`, async ({
    page,
  }) => {
    if (entry === 'detail') await page.locator('.row').click()
    const url = page.url()
    const opener = page.getByRole('button', { name: '播放视频' })
    await opener.click()
    const dialog = page.getByRole('dialog', { name: '视频预览' })
    const video = dialog.locator('video')
    await expect(video).toBeVisible()
    await expect(video).toHaveAttribute('controls', '')
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => v.paused))
      .toBe(false)
    const element = await video.elementHandle()
    expect(await element!.evaluate((v: HTMLVideoElement) => v.paused)).toBe(
      false,
    )
    await dialog.getByRole('button', { name: '下一张' }).click()
    await expect(page.getByRole('dialog').getByRole('status')).toHaveText(
      '2 / 2',
    )
    expect(await element!.evaluate((v: HTMLVideoElement) => v.paused)).toBe(
      true,
    )
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '上一张' })
      .click()
    await expect(video).toBeVisible()
    await expect
      .poll(() => video.evaluate((v: HTMLVideoElement) => v.paused))
      .toBe(false)
    await dialog.getByRole('button', { name: '关闭视频' }).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(await element!.evaluate((v: HTMLVideoElement) => v.paused)).toBe(
      true,
    )
    await expect(opener).toBeFocused()
    expect(page.url()).toBe(url)
  })
}

test('video errors remain closable and can navigate to images', async ({
  page,
}) => {
  await page.route('**/v1/assets/clip?*', (r) => r.fulfill({ status: 404 }))
  await page.getByRole('button', { name: '播放视频' }).click()
  await expect(page.getByRole('alert')).toContainText('视频无法播放')
  await page.getByRole('button', { name: '下一张' }).click()
  await expect(page.getByRole('dialog').getByAltText('测试图片')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('detail image and video thumbnails have equal rows with uncropped media', async ({
  page,
}) => {
  await page.locator('.row').click()
  for (const width of [320, 390, 560]) {
    await page.setViewportSize({ width, height: 844 })
    const frames = page.locator('.media .frame')
    await expect(frames).toHaveCount(2)
    const boxes = await frames.evaluateAll((elements) =>
      elements.map((el) => ({
        height: el.getBoundingClientRect().height,
        top: el.getBoundingClientRect().top,
      })),
    )
    expect(Math.abs(boxes[0]!.height - boxes[1]!.height)).toBeLessThan(1)
    expect(Math.abs(boxes[0]!.top - boxes[1]!.top)).toBeLessThan(1)
    await expect(page.locator('.media img')).toHaveCSS('object-fit', 'contain')
    await expect(page.locator('.media video')).toHaveCSS(
      'object-fit',
      'contain',
    )
  }
})
