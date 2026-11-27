import process from 'node:process'
import { expect, test, type Page } from './test'

const id = '33333333-3333-4333-8333-333333333333'

/** An image whose stored size, and the file itself, are `width` by `height`. */
const image = (n: number, width: number, height: number, sized = true) => ({
  id: `shape-${n}-${width}x${height}`,
  url: `/v1/assets/shape-${n}-${width}x${height}?inline=1`,
  state: 'ready',
  mime: 'image/png',
  sensitive: false,
  alt_text: `图 ${n}`,
  ...(sized ? { thumbnail: true, width: width / 4, height: height / 4 } : {}),
})
const collection = (assets: unknown[]) => ({
  id,
  url: 'https://example.test/shapes',
  text: '媒体比例',
  author_name: '比例测试',
  observed_at: '2026-09-30T10:00:00Z',
  saved_at: '2026-09-30T10:00:00Z',
  revision_id: 'r1',
  warnings: [],
  assets,
})

async function serve(page: Page, assets: unknown[]) {
  const item = collection(assets)
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (r) => {
    const path = new URL(r.request().url()).pathname
    const shape = /\/v1\/assets\/shape-\d+-(\d+)x(\d+)/.exec(path)
    if (shape)
      return r.fulfill({
        contentType: 'image/svg+xml',
        body: `<svg xmlns="http://www.w3.org/2000/svg" width="${shape[1]}" height="${shape[2]}"><rect width="${shape[1]}" height="${shape[2]}" fill="#4a6b8a"/><circle cx="${Number(shape[2]) / 2}" cy="${Number(shape[2]) / 2}" r="${Number(shape[2]) / 3}" fill="#e8c36a"/></svg>`,
      })
    const body =
      path === '/v1/session'
        ? {}
        : path.endsWith('/availability')
          ? { available: true }
          : path.endsWith('/history')
            ? {
                items: [
                  {
                    capture_id: 'c1',
                    observed_at: item.observed_at,
                    revision_id: 'r1',
                  },
                ],
              }
            : path === `/v1/collections/${id}`
              ? item
              : path === '/v1/collections/authors'
                ? { items: [] }
                : path === '/v1/usage'
                  ? { used_bytes: 0 }
                  : { items: [item] }
    return r.fulfill({ json: body })
  })
}

async function detail(page: Page, assets: unknown[]) {
  // A fresh page: the app keeps what it has fetched for the same address.
  await page.goto('about:blank')
  await page.unrouteAll()
  await serve(page, assets)
  await page.goto(`/app/collection/${id}`)
  await expect(page.locator('.media .frame').first()).toBeVisible()
}

const box = async (locator: ReturnType<Page['locator']>) => {
  const rect = (await locator.boundingBox())!
  return { ...rect, ratio: rect.width / rect.height }
}

/** Where the screenshots of this run go, when asked for. */
const shots = process.env.MEDIA_SHOTS

for (const scheme of ['light', 'dark'] as const)
  test(`detail boxes follow each media's shape (${scheme})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme })
    const sets: [string, unknown[]][] = [
      ['wide', [image(1, 1200, 200)]],
      ['square', [image(1, 800, 800)]],
      ['tall', [image(1, 450, 800)]],
      ['wide-pair', [image(1, 1200, 200), image(2, 1200, 240)]],
      ['mixed-pair', [image(1, 800, 800), image(2, 1200, 600)]],
      ['three', [image(1, 800, 800), image(2, 800, 800), image(3, 1200, 400)]],
    ]
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
      for (const [name, assets] of sets) {
        await detail(page, assets)
        if (shots)
          await page
            .locator('.media-group')
            .screenshot({ path: `${shots}/${name}-${width}-${scheme}.png` })
      }
    }
  })

test('a wide single image gets a short box that its image fills', async ({
  page,
}) => {
  await detail(page, [image(1, 1200, 200)])
  const frame = await box(page.locator('.media .frame'))
  expect(frame.ratio).toBeCloseTo(6, 0)
  expect(frame.height).toBeLessThan(80)
  const img = await box(page.locator('.media .frame img'))
  // Nothing above or below the image.
  expect(img.height).toBeCloseTo(frame.height, 0)
  expect(img.width).toBeCloseTo(frame.width, 0)
})

const portraits = [
  ['9:16', 450, 800],
  ['3:4', 600, 800],
  ['4:5', 640, 800],
  ['1:3', 300, 900],
] as const
const screens = [
  [390, 844],
  [844, 390],
  [1440, 900],
] as const

for (const [vw, vh] of screens)
  for (const [name, w, h] of portraits) {
    test(`a ${name} image takes its own shape at ${vw}x${vh}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vw, height: vh })
      await detail(page, [image(1, w, h)])
      const frame = await box(page.locator('.media .frame'))
      // The shape of the media, unless the height cap narrows it first, and
      // then the box is narrower rather than barred.
      expect(frame.ratio).toBeCloseTo(w / h, 1)
      expect(frame.height).toBeLessThanOrEqual(Math.min(480, vh * 0.7) + 1)
      const img = await box(page.locator('.media .frame img'))
      expect(img.width).toBeCloseTo(frame.width, 0)
      expect(img.height).toBeCloseTo(frame.height, 0)
      // Aligned with the text, not centred in a wider box.
      const text = await box(page.getByText('媒体比例').first())
      expect(frame.x).toBeCloseTo(text.x, 0)
      const card = await box(page.locator('.media-group').locator('..'))
      if (frame.height > Math.min(480, vh * 0.7) - 2)
        expect(frame.width).toBeLessThan(card.width - 32)
    })

    test(`a ${name} image in a list row is as wide as its height makes it at ${vw}x${vh}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vw, height: vh })
      await serve(page, [image(1, w, h)])
      await page.goto('/app/')
      const tile = page.locator('.thumbs .tile')
      await expect(tile).toBeVisible()
      const rect = await box(tile)
      expect(rect.ratio).toBeCloseTo(w / h, 1)
      expect(rect.width).toBeCloseTo(rect.height * (w / h), 0)
      const img = await box(tile.locator('img'))
      expect(img.width).toBeCloseTo(rect.width, 0)
    })
  }

for (const [vw, vh] of screens)
  test(`a portrait image with no stored size settles on its own shape at ${vw}x${vh}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: vw, height: vh })
    await detail(page, [image(1, 450, 800, false)])
    const frame = page.locator('.media .frame')
    await expect
      .poll(async () => (await box(frame)).ratio)
      .toBeCloseTo(450 / 800, 1)
    const img = await box(frame.locator('img'))
    expect(img.width).toBeCloseTo((await box(frame)).width, 0)
    await page.goto('about:blank')
    await page.unrouteAll()
    await serve(page, [image(1, 450, 800, false)])
    await page.goto('/app/')
    const tile = page.locator('.thumbs .tile')
    await expect
      .poll(async () => (await box(tile)).ratio)
      .toBeCloseTo(450 / 800, 1)
  })

test('a portrait video is boxed by its poster, narrower than the card', async ({
  page,
}) => {
  await detail(page, [
    { ...image(1, 450, 800), mime: 'video/mp4', url: '/v1/assets/clip' },
  ])
  const frame = await box(page.locator('.media .frame'))
  expect(frame.ratio).toBeCloseTo(450 / 800, 1)
  expect(frame.width).toBeLessThan(
    (await box(page.locator('.media-group').locator('..'))).width - 40,
  )
})

test('portrait and landscape in one album share a height, without bars', async ({
  page,
}) => {
  await detail(page, [image(1, 450, 800), image(2, 1600, 900)])
  const [left, right] = await page.locator('.media .frame').all()
  const l = await box(left!)
  const r = await box(right!)
  expect(l.height).toBeCloseTo(r.height, 0)
  expect(l.ratio).toBeCloseTo(450 / 800, 1)
  expect(r.ratio).toBeCloseTo(16 / 9, 1)
  for (const frame of [left!, right!]) {
    const f = await box(frame)
    const img = await box(frame.locator('img'))
    expect(img.width).toBeCloseTo(f.width, 0)
    expect(img.height).toBeCloseTo(f.height, 0)
  }
})

test('a square keeps its shape and is not taller than the cap', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await detail(page, [image(1, 800, 800)])
  const frame = await box(page.locator('.media .frame'))
  expect(frame.ratio).toBeCloseTo(1, 1)
  expect(frame.height).toBeLessThanOrEqual(480)
})

test('the box is reserved before the image arrives', async ({ page }) => {
  await serve(page, [image(1, 1200, 200)])
  // Hold the file back: the box must already be its final size.
  await page.route('**/v1/assets/**', () => {})
  await page.goto(`/app/collection/${id}`)
  const frame = page.locator('.media .frame')
  await expect(frame).toBeVisible()
  expect((await box(frame)).ratio).toBeCloseTo(6, 0)
})

test('without a stored size the box follows the loaded image', async ({
  page,
}) => {
  await detail(page, [image(1, 1200, 300, false)])
  await expect
    .poll(async () => (await box(page.locator('.media .frame'))).ratio)
    .toBeCloseTo(4, 0)
})

test('two wide images are stacked; an ordinary pair shares a height', async ({
  page,
}) => {
  await detail(page, [image(1, 1200, 200), image(2, 1200, 240)])
  const [one, two] = await page.locator('.media .frame').all()
  const a = await box(one!)
  const b = await box(two!)
  expect(a.width).toBeCloseTo(b.width, 0)
  expect(b.y).toBeGreaterThan(a.y + a.height - 1)

  await detail(page, [image(1, 800, 800), image(2, 1200, 600)])
  const [left, right] = await page.locator('.media .frame').all()
  const l = await box(left!)
  const r = await box(right!)
  expect(l.height).toBeCloseTo(r.height, 0)
  expect(r.x).toBeGreaterThan(l.x + l.width - 1)
  expect(r.width / l.width).toBeCloseTo(2, 0)
})

test('a list row boxes a single wide image by its shape', async ({ page }) => {
  await serve(page, [image(1, 1200, 200)])
  await page.goto('/app/')
  const tile = page.locator('.thumbs .tile')
  await expect(tile).toBeVisible()
  const rect = await box(tile)
  expect(rect.ratio).toBeCloseTo(6, 0)
  const img = await box(tile.locator('img'))
  expect(img.height).toBeCloseTo(rect.height, 0)
})

test('an image with no smaller size boxes by the size the platform gave and shows the original', async ({
  page,
}) => {
  // What the server gives for an image that stands for itself: no
  // thumbnail, the original's size as the platform described it.
  const { thumbnail: _, ...plain } = image(1, 1200, 300)
  await serve(page, [{ ...plain, width: 1200, height: 300 }])
  await page.goto('/app/')
  const tile = page.locator('.thumbs .tile')
  await expect(tile.locator('img')).toHaveAttribute('src', plain.url)
  expect((await box(tile)).ratio).toBeCloseTo(4, 0)
})

test('a video with no poster keeps its placeholder in the shape the platform gave', async ({
  page,
}) => {
  const video = {
    id: 'clip-1',
    url: '/v1/assets/no-such-clip',
    state: 'ready',
    mime: 'video/mp4',
    kind: 'video',
    sensitive: false,
    width: 1080,
    height: 1920,
  }
  await serve(page, [video])
  await page.goto('/app/')
  const tile = page.locator('.thumbs .tile')
  await expect(tile).toBeVisible()
  await expect(tile.locator('img')).toHaveCount(0)
  // Boxed at once, though the video never loads.
  expect((await box(tile)).ratio).toBeCloseTo(1080 / 1920, 1)
  await detail(page, [video])
  expect((await box(page.locator('.media .frame').first())).ratio).toBeCloseTo(
    1080 / 1920,
    1,
  )
})

const sensitiveVideo = (width: number, height: number, sized = true) => ({
  ...image(1, width, height, sized),
  mime: 'video/mp4',
  url: '/v1/assets/clip',
  sensitive: true,
  thumbnail: true,
  thumbnail_url: `/v1/assets/shape-0-${Math.round(width / 4)}x${Math.round(height / 4)}`,
})

for (const [vw, vh] of screens)
  for (const sized of [true, false])
    test(`a sensitive portrait video keeps its box while blurred at ${vw}x${vh}${sized ? '' : ' with no stored size'}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: vw, height: vh })
      await serve(page, [sensitiveVideo(450, 800, sized)])
      await page.goto('/app/')
      const tile = page.locator('.thumbs .tile')
      await expect(tile).toBeVisible()
      await expect(tile.locator('img')).toBeVisible()
      // Without a stored size the box is 4:3 until the picture has loaded.
      await expect
        .poll(async () => (await box(tile)).ratio)
        .toBeCloseTo(450 / 800, 1)
      const blurred = await box(tile)
      expect(blurred.ratio).toBeCloseTo(450 / 800, 1)
      // The blurred picture covers the whole box: no flat strip beside it.
      const img = await box(tile.locator('img'))
      expect(img.x).toBeLessThanOrEqual(blurred.x + 1)
      expect(img.x + img.width).toBeGreaterThanOrEqual(
        blurred.x + blurred.width - 1,
      )
      expect(img.y).toBeLessThanOrEqual(blurred.y + 1)
      expect(img.y + img.height).toBeGreaterThanOrEqual(
        blurred.y + blurred.height - 1,
      )
      // One reveal icon over the whole box, in its middle; no play glyph by it.
      await expect(tile.locator('.play')).toHaveCount(0)
      const veil = page.locator('.group-veil')
      const cover = await box(veil)
      expect(cover.width).toBeCloseTo(blurred.width, 0)
      expect(cover.height).toBeCloseTo(blurred.height, 0)
      const eye = await box(veil.locator('svg'))
      expect(eye.x + eye.width / 2).toBeCloseTo(
        blurred.x + blurred.width / 2,
        0,
      )
      expect(eye.y + eye.height / 2).toBeCloseTo(
        blurred.y + blurred.height / 2,
        0,
      )
      // Revealing changes nothing about the box.
      await veil.click()
      await expect(veil).toHaveCount(0)
      await expect(tile.locator('.play')).toHaveCount(1)
      const revealed = await box(tile)
      expect(revealed.width).toBeCloseTo(blurred.width, 0)
      expect(revealed.height).toBeCloseTo(blurred.height, 0)
      const sharp = await box(tile.locator('img'))
      expect(sharp.width).toBeCloseTo(revealed.width, 0)
      expect(sharp.height).toBeCloseTo(revealed.height, 0)
    })

test('a sensitive portrait video in the detail page is boxed alike, blurred or not', async ({
  page,
}) => {
  await detail(page, [sensitiveVideo(450, 800)])
  const frame = page.locator('.media .frame')
  const blurred = await box(frame)
  expect(blurred.ratio).toBeCloseTo(450 / 800, 1)
  await expect(frame.locator('.play')).toHaveCount(0)
  const veil = page.locator('.group-veil')
  const cover = await box(veil)
  expect(cover.width).toBeCloseTo(blurred.width, 0)
  expect(cover.height).toBeCloseTo(blurred.height, 0)
  const eye = await box(veil.locator('svg'))
  expect(eye.x + eye.width / 2).toBeCloseTo(blurred.x + blurred.width / 2, 0)
  expect(eye.y + eye.height / 2).toBeCloseTo(blurred.y + blurred.height / 2, 0)
  await veil.click()
  await expect(veil).toHaveCount(0)
  const revealed = await box(frame)
  expect(revealed.width).toBeCloseTo(blurred.width, 0)
  expect(revealed.height).toBeCloseTo(blurred.height, 0)
  await expect(frame.locator('.play')).toHaveCount(1)
})
