import { fileURLToPath } from 'node:url'
import { expect, test, type Locator, type Page } from './test'
import { thumb } from './viewer'

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
  await page.goto('/')
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
    '.chrome-top .glass, .chrome-bottom, .pswp__item > .slide-caption',
  )
  const boxes = []
  for (const part of await parts.all()) {
    // A caption can be replaced while the others are read.
    const found = await part.boundingBox().catch(() => null)
    if (found) boxes.push(found)
  }
  return boxes
}

/** The chrome parts the media lies under, none when it is clear of them. */
async function covered(page: Page, media: Locator) {
  const found = await media.boundingBox().catch(() => null)
  // Not laid out yet: not clear either.
  if (!found) return ['not shown']
  return (await chromeBoxes(page)).filter((part) => overlaps(found, part))
}

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
    for (const [slot, alt] of [
      [1, '竖图'],
      [2, '横图'],
    ] as const) {
      await thumb(page, slot).click()
      const image = dialog.getByAltText(alt)
      await expect(image).toBeVisible()
      // The slide settles once the image's own size is known.
      await expect.poll(() => covered(page, image)).toEqual([])
      expect((await box(image)).width).toBeGreaterThan(50)
    }
  })
}

test('a video never overlaps the text, in any viewport', async ({ page }) => {
  const dialog = page.getByRole('dialog')
  await thumb(page, 3).click()
  await expect(dialog.getByRole('status').first()).toHaveText('3 / 3')
  const video = dialog.locator('.stage video')
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
})

test('a long caption is cut to a few lines and the image keeps its height', async ({
  page,
}) => {
  const dialog = page.getByRole('dialog')
  const caption = dialog.locator('.pswp__item > .slide-caption').first()
  await expect(caption).toBeVisible()
  // Author row plus three lines: well under a third of the screen.
  expect((await box(caption)).height).toBeLessThan(844 * 0.3)
  await expect(dialog.locator('.caption-body').first()).toHaveCSS(
    '-webkit-line-clamp',
    '3',
  )
  const image = dialog.getByAltText('竖图')
  await expect.poll(async () => (await box(image)).height).toBeGreaterThan(450)
})

test('the caption travels with its slide while swiping', async ({ page }) => {
  const dialog = page.getByRole('dialog')
  await expect(thumb(page, 2)).toBeEnabled()
  const first = dialog.locator('.pswp__item > .slide-caption').first()
  const before = (await box(first)).x
  const client = await page.context().newCDPSession(page)
  try {
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: 300, y: 300 }],
    })
    for (const x of [280, 240, 200, 160]) {
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y: 300 }],
      })
      await page.waitForTimeout(30)
    }
    // Half a swipe: this slide's caption has moved off with its image, and
    // the next slide's has come in with its own.
    await expect
      .poll(async () => (await box(first)).x)
      .toBeLessThan(before - 100)
    const captions = dialog.locator('.pswp__item > .slide-caption')
    const xs = await Promise.all(
      (await captions.all()).map(async (c) => (await box(c)).x),
    )
    expect(xs.some((x) => x > 0 && x < 390)).toBe(true)
    // Let go past half way. The slide changes then whatever the speed; short
    // of it, PhotoSwipe needs a fast flick, and the pause the reads above take
    // would let the finger's speed die away.
    for (const x of [120, 80, 40]) {
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y: 300 }],
      })
    }
    await client.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    })
  } finally {
    await client.detach()
  }
  await expect(dialog.getByRole('status').first()).toHaveText('2 / 3')
})

test('the thumbnail strip follows the viewer and scrubs it', async ({
  page,
}) => {
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('group', { name: '媒体缩略图' })).toBeVisible()
  await expect(thumb(page, 1)).toHaveAttribute('aria-current', 'true')
  await thumb(page, 3).click()
  await expect(dialog.getByRole('status').first()).toHaveText('3 / 3')
  await page.keyboard.press('ArrowLeft')
  await expect(thumb(page, 2)).toHaveAttribute('aria-current', 'true')
  // The shown item's thumbnail comes to rest in the middle of the strip: on
  // either side of it counts as not there yet.
  const offCentre = async () => {
    const strip = await box(dialog.locator('.strip'))
    const current = await box(dialog.locator('.thumb.on'))
    return Math.abs(
      Math.round(current.x + current.width / 2 - (strip.x + strip.width / 2)),
    )
  }
  await expect.poll(offCentre).toBeLessThanOrEqual(1)
  // Still, once it has stopped: a scroll in flight would be read as a hand's.
  await expect
    .poll(() =>
      dialog.locator('.strip').evaluate(
        (el) =>
          new Promise<number>((resolve) => {
            const at = el.scrollLeft
            requestAnimationFrame(() =>
              requestAnimationFrame(() => resolve(el.scrollLeft - at)),
            )
          }),
      ),
    )
    .toBe(0)
  // Dragging the strip moves the viewer to the thumbnail it stops on.
  const strip = await box(dialog.locator('.strip'))
  const y = strip.y + strip.height / 2
  await page.mouse.move(strip.x + strip.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(strip.x + strip.width / 2 + 40, y, { steps: 6 })
  await page.mouse.up()
  await expect(dialog.getByRole('status').first()).toHaveText('1 / 3')
  await expect(thumb(page, 1)).toHaveAttribute('aria-current', 'true')
})
