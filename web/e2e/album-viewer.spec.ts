import { expect, test, type Page } from './test'
import { thumb } from './viewer'

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#678"/></svg>'
const recordId = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const record = (n: number) => ({
  id: recordId(n),
  assets: [
    {
      id: `img-${n}`,
      url: `/v1/assets/img-${n}?inline=1`,
      mime: 'image/png',
      sensitive: false,
      state: 'ready',
    },
  ],
  text: '正文',
  author_name: '作者',
  url: 'https://example.test/post',
  revision_id: 'r1',
  observed_at: '2026-09-30T10:00:00Z',
  saved_at: '2026-09-30T10:00:00Z',
})
const range = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => record(from + i))

/**
 * The album over pages of posts, one image each. `gate` holds the answer to
 * the request for the second page until it is opened.
 */
async function setup(page: Page, pages: ReturnType<typeof record>[][]) {
  const lists: string[] = []
  const usage: string[] = []
  const removals: unknown[] = []
  const gate = Promise.withResolvers<void>()
  let hold = false
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', async (r) => {
    const u = new URL(r.request().url())
    if (u.pathname.startsWith('/v1/assets/'))
      return r.fulfill({ contentType: 'image/svg+xml', body: svg })
    if (u.pathname === '/v1/collections') {
      const cursor = u.searchParams.get('cursor') ?? ''
      lists.push(cursor)
      const at = cursor ? Number(cursor.slice(1)) - 1 : 0
      if (cursor && hold) await gate.promise
      return r.fulfill({
        json: {
          items: pages[at],
          ...(at + 1 < pages.length ? { next_cursor: `p${at + 2}` } : {}),
        },
      })
    }
    if (u.pathname === '/v1/media-removals/preview')
      return r.fulfill({ json: { media: 1, freed_bytes: 10, shared: 0 } })
    if (u.pathname === '/v1/media-removals') {
      removals.push(r.request().postDataJSON())
      return r.fulfill({ json: { media: 1, freed_bytes: 10, shared: 0 } })
    }
    if (u.pathname === '/v1/usage') {
      usage.push(u.pathname)
      return r.fulfill({ json: { used_bytes: 1000 } })
    }
    return r.fulfill({
      json: u.pathname.endsWith('/count') ? { count: 0 } : {},
    })
  })
  return {
    lists,
    usage,
    removals,
    hold: () => (hold = true),
    release: () => gate.resolve(),
  }
}

const viewer = (page: Page) => page.getByRole('dialog', { name: '图片预览' })
const tiles = (page: Page) => page.locator('.album button')
/** Which item the viewer is on, by its thumbnail in the strip. */
const current = (page: Page) =>
  viewer(page).locator('.thumb[aria-current] img').getAttribute('src')

async function remove(page: Page) {
  await viewer(page).getByRole('button', { name: '更多' }).click()
  await page.getByRole('menuitem', { name: '删除此媒体' }).click()
  const sheet = page.getByRole('dialog', { name: '删除此媒体？' })
  await sheet.getByRole('button', { name: '删除', exact: true }).click()
}

test('deleting in the viewer keeps it open on the next item, and the list where it was', async ({
  page,
}) => {
  const seen = await setup(page, [range(1, 41)])
  await page.goto('/app/?layout=album')
  await expect(tiles(page)).toHaveCount(40)
  await page.evaluate(() => window.scrollTo(0, 500))
  const scrolled = await page.evaluate(() => window.scrollY)
  expect(scrolled).toBeGreaterThan(0)
  const lists = seen.lists.length
  const usage = seen.usage.length
  await tiles(page).nth(10).click()
  await expect(viewer(page).locator('.counter')).toHaveText('11 / 40')
  await expect(thumb(page, 11)).toBeEnabled()
  const before = await page.evaluate(() => window.scrollY)
  await remove(page)
  // The next item takes its place; the viewer is still open.
  await expect(viewer(page).locator('.counter')).toHaveText('11 / 39')
  expect(await current(page)).toContain('/img-12')
  await expect(page.getByText('已删除 1 个媒体')).toBeVisible()
  expect(seen.removals).toEqual([{ collection: recordId(11), asset: 'img-11' }])
  // The tile behind it is gone, with no list loaded again and no skeleton.
  await expect(tiles(page)).toHaveCount(39)
  await expect(page.locator('.album > .skeleton')).toHaveCount(0)
  expect(seen.lists).toHaveLength(lists)
  expect(seen.usage).toHaveLength(usage)
  expect(await page.evaluate(() => window.scrollY)).toBe(before)
  // The viewer goes on: the item after is the one that was twelfth.
  await page.keyboard.press('ArrowRight')
  await expect(viewer(page).locator('.counter')).toHaveText('12 / 39')
  expect(await current(page)).toContain('/img-13')
  await page.keyboard.press('Escape')
  await expect(viewer(page)).toHaveCount(0)
  expect(await page.evaluate(() => window.scrollY)).toBe(scrolled)
  expect(seen.lists).toHaveLength(lists)
})

test('deleting the last item moves back to the one before it, and the last one closes the viewer', async ({
  page,
}) => {
  const seen = await setup(page, [range(1, 4)])
  await page.goto('/app/?layout=album')
  await expect(tiles(page)).toHaveCount(3)
  await tiles(page).nth(2).click()
  await expect(viewer(page).locator('.counter')).toHaveText('3 / 3')
  await expect(thumb(page, 1)).toBeEnabled()
  await remove(page)
  await expect(viewer(page).locator('.counter')).toHaveText('2 / 2')
  expect(await current(page)).toContain('/img-2')
  await expect(tiles(page)).toHaveCount(2)
  await remove(page)
  // One item left: no counter, still open.
  await expect(viewer(page).locator('.counter')).toHaveCount(0)
  await expect(viewer(page).locator('.stage img[src*="/img-1?"]')).toBeVisible()
  await expect(tiles(page)).toHaveCount(1)
  await remove(page)
  await expect(viewer(page)).toHaveCount(0)
  await expect(tiles(page)).toHaveCount(0)
  expect(seen.lists).toHaveLength(1)
})

test('the viewer asks for the next page near the end and goes on into it', async ({
  page,
}) => {
  const seen = await setup(page, [range(1, 91), range(91, 101)])
  seen.hold()
  await page.goto('/app/?layout=album')
  await expect(tiles(page)).toHaveCount(90)
  await page.evaluate(() => window.scrollTo(0, 500))
  const scrolled = await page.evaluate(() => window.scrollY)
  await tiles(page).nth(10).click()
  await expect(thumb(page, 1)).toBeEnabled()
  // Far from the end, nothing is asked for.
  await thumb(page, 86).click()
  await expect(viewer(page).locator('.counter')).toHaveText('86 / 90')
  await page.waitForTimeout(300)
  expect(seen.lists).toEqual([''])
  // A few items before the end, the next page is.
  await thumb(page, 87).click()
  await expect.poll(() => seen.lists).toEqual(['', 'p2'])
  await thumb(page, 90).click()
  await page.keyboard.press('ArrowRight')
  // The page is not in: a skeleton stands where its first item will be.
  await expect(viewer(page).locator('.more-slide')).toBeVisible()
  await expect(viewer(page).locator('.counter')).toHaveText('90 / 90')
  seen.release()
  await expect(viewer(page).locator('.counter')).toHaveText('91 / 100')
  expect(await current(page)).toContain('/img-91')
  await expect(viewer(page).locator('.more-slide')).toHaveCount(0)
  // The grid behind has the page too, and it was asked for once.
  await expect(tiles(page)).toHaveCount(100)
  await page.keyboard.press('ArrowRight')
  await expect(viewer(page).locator('.counter')).toHaveText('92 / 100')
  await page.keyboard.press('Escape')
  await expect(viewer(page)).toHaveCount(0)
  expect(await page.evaluate(() => window.scrollY)).toBe(scrolled)
  expect(seen.lists).toEqual(['', 'p2'])
})

test('at the true end next does nothing', async ({ page }) => {
  const seen = await setup(page, [range(1, 91), range(91, 94)])
  await page.goto('/app/?layout=album')
  await expect(tiles(page)).toHaveCount(90)
  await page.evaluate(() => window.scrollTo(0, 500))
  await tiles(page).nth(10).click()
  await expect(thumb(page, 1)).toBeEnabled()
  await thumb(page, 90).click()
  // The last page is the viewer's to ask for, and comes in behind it.
  await expect(viewer(page).locator('.counter')).toHaveText('90 / 93')
  await page.keyboard.press('ArrowRight')
  await expect(viewer(page).locator('.counter')).toHaveText('91 / 93')
  await thumb(page, 93).click()
  await expect(viewer(page).locator('.counter')).toHaveText('93 / 93')
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(300)
  await expect(viewer(page).locator('.counter')).toHaveText('93 / 93')
  await expect(viewer(page).locator('.more-slide')).toHaveCount(0)
  expect(seen.lists).toEqual(['', 'p2'])
})

test('deleting in the viewer from a post keeps it open, and the post shows the media as removed', async ({
  page,
}) => {
  const id = recordId(1)
  const post = {
    ...record(1),
    assets: ['one', 'two', 'three'].map((name) => ({
      id: name,
      url: `/v1/assets/${name}?inline=1`,
      mime: 'image/png',
      sensitive: false,
      state: 'ready',
    })),
  }
  const loads: string[] = []
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (r) => {
    const path = new URL(r.request().url()).pathname
    if (path.startsWith('/v1/assets/'))
      return r.fulfill({ contentType: 'image/svg+xml', body: svg })
    if (path === `/v1/collections/${id}`) {
      loads.push(path)
      return r.fulfill({ json: post })
    }
    if (path.startsWith('/v1/media-removals'))
      return r.fulfill({ json: { media: 1, freed_bytes: 10, shared: 0 } })
    return r.fulfill({
      json: path.endsWith('/availability')
        ? { available: true }
        : path.endsWith('/history')
          ? { items: [] }
          : {},
    })
  })
  await page.goto(`/app/collection/${id}`)
  await page.getByRole('button', { name: '放大图片' }).nth(1).click()
  await expect(viewer(page).locator('.counter')).toHaveText('2 / 3')
  await expect(thumb(page, 1)).toBeEnabled()
  await remove(page)
  await expect(viewer(page).locator('.counter')).toHaveText('2 / 2')
  expect(await current(page)).toContain('/three')
  // The post behind shows it as removed, without loading again.
  await expect(page.locator('.media .removed')).toHaveCount(1)
  expect(loads).toHaveLength(1)
  await page.keyboard.press('Escape')
  await expect(viewer(page)).toHaveCount(0)
  await expect(page.getByRole('button', { name: '放大图片' })).toHaveCount(2)
})
