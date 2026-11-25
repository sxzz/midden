import { fileURLToPath } from 'node:url'
import { expect, test, type Locator, type Page } from './test'

const longText = Array.from(
  { length: 40 },
  (_, i) => `第 ${i + 1} 行：这是一段很长的帖子正文，用来撑高底部的文字区域。`,
).join('\n')
const collection = {
  id: '11111111-1111-4111-8111-111111111111',
  text: longText,
  author_name: '适配测试',
  url: 'https://example.test/fit',
  revision_id: 'r1',
  assets: [
    {
      id: 'tall',
      url: '/v1/assets/tall?inline=1',
      mime: 'image/svg+xml',
      state: 'ready',
      alt_text: '竖图',
    },
    {
      id: 'wide',
      url: '/v1/assets/wide?inline=1',
      mime: 'image/svg+xml',
      state: 'ready',
      alt_text: '横图',
    },
    {
      id: 'clip',
      url: '/v1/assets/clip?inline=1',
      mime: 'video/webm',
      state: 'ready',
      alt_text: '视频',
    },
  ],
}
const svg = (width: number, height: number, fill: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><path fill="${fill}" d="M0 0h${width}v${height}H0z"/></svg>`

test.beforeEach(async ({ page }) => {
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (r) => {
    const path = new URL(r.request().url()).pathname
    if (path === '/v1/assets/tall')
      return r.fulfill({
        contentType: 'image/svg+xml',
        body: svg(900, 2400, '#c0392b'),
      })
    if (path === '/v1/assets/wide')
      return r.fulfill({
        contentType: 'image/svg+xml',
        body: svg(2400, 600, '#2980b9'),
      })
    if (path === '/v1/assets/clip')
      return r.fulfill({
        path: fileURLToPath(new URL('fixtures/preview.webm', import.meta.url)),
        contentType: 'video/webm',
      })
    return r.fulfill({
      json: path.endsWith('/availability')
        ? { available: true }
        : path.endsWith('/history')
          ? { items: [] }
          : path === `/v1/collections/${collection.id}`
            ? collection
            : path === '/v1/collections'
              ? { items: [collection] }
              : {},
    })
  })
  await page.goto('/app/')
  await expect(page.locator('.row .head')).toBeVisible()
  await page.locator('.row .head').click()
  await page.getByRole('button', { name: '放大图片' }).first().click()
})

async function box(locator: Locator) {
  const found = await locator.boundingBox()
  expect(found).not.toBeNull()
  return found!
}
const overlaps = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) =>
  a.x < b.x + b.width - 0.5 &&
  b.x < a.x + a.width - 0.5 &&
  a.y < b.y + b.height - 0.5 &&
  b.y < a.y + a.height - 0.5

/** Every part of the viewer's chrome that carries text or controls. */
async function chromeBoxes(page: Page) {
  const dialog = page.getByRole('dialog')
  const parts = dialog.locator(
    '.chrome-top .glass, .post-caption, .caption, .remote, .chrome-bottom .text',
  )
  const boxes = []
  for (const part of await parts.all())
    if (await part.isVisible()) boxes.push(await box(part))
  return boxes
}

/** The chrome parts the media lies under, none when it is clear of them. */
async function covered(page: Page, media: Locator) {
  const found = await box(media)
  return (await chromeBoxes(page)).filter((part) => overlaps(found, part))
}
const next = (page: Page) =>
  page.getByRole('dialog').getByRole('button', { name: '下一张' })

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
  { width: 844, height: 390 },
]) {
  test(`images fit clear of the text at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport)
    const dialog = page.getByRole('dialog')
    const steps = [
      { alt: '竖图', expand: false },
      { alt: '竖图', expand: true },
      { alt: '横图', expand: false },
    ]
    for (const [i, step] of steps.entries()) {
      if (step.expand) await dialog.locator('.caption-body').click()
      else if (i > 0) await next(page).click()
      const image = dialog.getByAltText(step.alt)
      await expect(image).toBeVisible()
      // The slide settles once the image's own size is known and the text
      // area has its final height.
      await expect.poll(() => covered(page, image)).toEqual([])
      expect((await box(image)).width).toBeGreaterThan(50)
    }
  })
}

test('a video never overlaps the text, in any viewport', async ({ page }) => {
  const dialog = page.getByRole('dialog')
  await next(page).click()
  await expect(dialog.getByRole('status').first()).toHaveText('2 / 3')
  await next(page).click()
  await expect(dialog.getByRole('status').first()).toHaveText('3 / 3')
  const video = dialog.locator('video')
  await expect(video).toBeVisible()
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1280, height: 800 },
    { width: 844, height: 390 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport)
    await expect.poll(() => covered(page, video)).toEqual([])
    const media = await box(video)
    expect(media.x).toBeGreaterThanOrEqual(0)
    expect(media.x + media.width).toBeLessThanOrEqual(viewport.width)
    expect(media.height).toBeGreaterThan(100)
  }
  // The text area at its tallest still leaves the video its own space.
  await dialog.locator('.caption-body').click()
  await expect.poll(() => covered(page, video)).toEqual([])
  expect((await box(video)).height).toBeGreaterThan(300)
})

test('a long caption scrolls inside its cap and the image keeps its height', async ({
  page,
}) => {
  const dialog = page.getByRole('dialog')
  await dialog.locator('.caption-body').click()
  const text = dialog.locator('.chrome-bottom .text')
  await expect
    .poll(() => text.evaluate((el) => el.scrollHeight > el.clientHeight))
    .toBe(true)
  const image = dialog.getByAltText('竖图')
  await expect.poll(async () => (await box(image)).height).toBeGreaterThan(300)
  const viewer = await box(dialog)
  expect(
    (await box(dialog.locator('.chrome-bottom'))).height,
  ).toBeLessThanOrEqual(viewer.height * 0.6)
})
