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
  await page.goto(`/app/#/collection/${id}`)
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

test('tall images stop at 3:4 and stay within the screen', async ({ page }) => {
  await detail(page, [image(1, 450, 800)])
  const frame = await box(page.locator('.media .frame'))
  expect(frame.ratio).toBeCloseTo(0.75, 1)
  expect(frame.height).toBeLessThan(844 * 0.7 + 1)
  // Letterboxed rather than cropped: the whole image stays visible.
  await expect(page.locator('.media .frame img')).toHaveCSS(
    'object-fit',
    'contain',
  )
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
  await page.goto(`/app/#/collection/${id}`)
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
