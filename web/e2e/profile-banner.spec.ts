import { expect, test, type Page } from './test'

const id = '22222222-2222-4222-8222-222222222222'
const slug = 'AbCdEfGhIjKlMnOpQrStUv_-'
const REMOTE = 'https://pbs.twimg.com/profile_banners/7/1/1500x500'

const svg = (width: number, height: number, fill: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="${fill}"/></svg>`
const avatar = {
  id: 'avatar',
  purpose: 'avatar',
  position: 0,
  kind: 'image',
  state: 'ready',
  sensitive: false,
  mime: 'image/svg+xml',
  url: '/v1/assets/avatar',
}
/** Saved here: a 600x200 thumbnail to show, the 1500x500 original to open. */
const saved = {
  id: 'banner',
  purpose: 'banner',
  position: 1,
  kind: 'image',
  state: 'ready',
  sensitive: false,
  mime: 'image/svg+xml',
  url: '/v1/assets/banner-original',
  thumbnail_url: '/v1/assets/banner-thumbnail',
  width: 600,
  height: 200,
}
/** Never downloaded: only the platform has it. */
const remote = {
  id: 'banner',
  purpose: 'banner',
  position: 1,
  kind: 'image',
  state: 'failed',
  sensitive: false,
  remote_url: REMOTE,
}

function profile(...banner: object[]) {
  return {
    id,
    url: 'https://x.com/mountain_log',
    external_id: '7',
    provider_id: 'x',
    revision_id: 'r1',
    text: '账号简介',
    text_kind: 'plain',
    adapter_version: '1',
    warnings: [],
    observed_at: '2026-11-05T08:00:00Z',
    saved_at: '2026-11-05T08:00:00Z',
    created_at: '2026-11-01T08:00:00Z',
    assets: [],
    graph: {
      root: 'root',
      entities: [
        {
          key: 'root',
          type: 'x.profile',
          external_id: '7',
          data: {
            name: '山野记录',
            username: 'mountain_log',
            metadata: { description: '记录山野与城市之间的日常。' },
          },
          resource_indices: [0, ...banner.map((_, index) => index + 1)],
          assets: [avatar, ...banner],
        },
      ],
      relations: [],
    },
  }
}

interface Options {
  /** Slows the banner thumbnail, to look at the page while it loads. */
  slowThumbnail?: Promise<void>
  /** The bytes of the platform's own banner were asked for. */
  remoteRequests?: string[]
}

async function serve(page: Page, collection: object, options: Options = {}) {
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route(REMOTE, (r) => {
    options.remoteRequests?.push(r.request().url())
    return r.fulfill({
      contentType: 'image/svg+xml',
      body: svg(1500, 500, '#3a6'),
    })
  })
  await page.route('**/v1/**', async (r) => {
    const path = new URL(r.request().url()).pathname
    if (path === '/v1/assets/banner-thumbnail') {
      await options.slowThumbnail
      return r.fulfill({
        contentType: 'image/svg+xml',
        body: svg(600, 200, '#36a'),
      })
    }
    if (path === '/v1/assets/banner-original')
      return r.fulfill({
        contentType: 'image/svg+xml',
        body: svg(1500, 500, '#a63'),
      })
    if (path.startsWith('/v1/assets/'))
      return r.fulfill({
        contentType: 'image/svg+xml',
        body: svg(200, 200, '#888'),
      })
    const body =
      path === '/v1/session'
        ? {}
        : path === `/v1/collections/${id}`
          ? collection
          : path.endsWith('/history') || path.endsWith('/profile-changes')
            ? { items: [] }
            : path.endsWith('/counts')
              ? { points: [] }
              : path.endsWith('/availability')
                ? { available: true }
                : path === '/v1/tags'
                  ? []
                  : { items: [collection] }
    return r.fulfill({ json: body })
  })
}

const box = async (locator: ReturnType<Page['locator']>) =>
  (await locator.boundingBox())!

/** The banner is 3:1, spans its card, and the avatar sits half on it. */
async function expectCover(page: Page) {
  const card = await box(page.locator('.section-body').first())
  const cover = await box(page.locator('.cover'))
  expect(cover.width).toBeCloseTo(card.width, 0)
  expect(cover.x).toBeCloseTo(card.x, 0)
  expect(cover.y).toBeCloseTo(card.y, 0)
  expect(cover.width / cover.height).toBeCloseTo(3, 1)
  const avatarBox = await box(page.locator('article.post .author > .avatar'))
  const coverBottom = cover.y + cover.height
  // Half of the avatar is over the banner, at its bottom-left, inside the inset.
  expect(avatarBox.y).toBeLessThan(coverBottom)
  expect(avatarBox.y + avatarBox.height).toBeGreaterThan(coverBottom)
  expect(coverBottom - avatarBox.y).toBeCloseTo(avatarBox.height / 2, 0)
  expect(avatarBox.x - cover.x).toBeCloseTo(16, 0)
  // The name starts below the banner, as on X.
  const name = await box(page.locator('article.post .identity .name'))
  expect(name.y).toBeGreaterThan(coverBottom)
}

const sizes = [
  ['390 px', { width: 390, height: 844 }],
  ['1280 px', { width: 1280, height: 800 }],
] as const

for (const [label, viewport] of sizes) {
  test.describe(`at ${label}`, () => {
    test.use({ viewport })

    test('the profile page shows its saved banner, which opens the original', async ({
      page,
    }) => {
      await serve(page, profile(saved))
      await page.goto(`/collection/${id}`)
      const cover = page.getByRole('button', { name: '查看山野记录的主页封面' })
      await expect(cover.locator('img')).toHaveAttribute(
        'src',
        '/v1/assets/banner-thumbnail',
      )
      await expect(cover.locator('img')).toHaveCSS('opacity', '1')
      await expectCover(page)
      if (viewport.width >= 1000)
        expect((await box(page.locator('.cover'))).width).toBeLessThanOrEqual(
          680,
        )
      await expect(page.locator('article.post .body')).toBeVisible()

      await cover.click()
      const dialog = page.getByRole('dialog', { name: '图片预览' })
      await expect(dialog.locator('.pswp__img').last()).toHaveAttribute(
        'src',
        '/v1/assets/banner-original',
      )
      await dialog.getByRole('button', { name: '关闭图片' }).click()
      await expect(dialog).toHaveCount(0)
      await expect(cover).toBeFocused()
      // The avatar still opens its own.
      await page.getByRole('button', { name: '查看山野记录的头像' }).click()
      await expect(
        page
          .getByRole('dialog', { name: '图片预览' })
          .locator('.pswp__img')
          .last(),
      ).toHaveAttribute('src', '/v1/assets/avatar')
    })

    test('the box is reserved while the banner loads', async ({ page }) => {
      const { promise: slowThumbnail, resolve: release } =
        Promise.withResolvers<void>()
      await serve(page, profile(saved), { slowThumbnail })
      await page.goto(`/collection/${id}`)
      await expect(page.locator('.cover .skeleton')).toBeVisible()
      const before = await box(page.locator('.section-body').first())
      expect(
        (await box(page.locator('.cover'))).width /
          (await box(page.locator('.cover'))).height,
      ).toBeCloseTo(3, 1)
      release()
      await expect(page.locator('.cover img')).toHaveCSS('opacity', '1')
      const after = await box(page.locator('.section-body').first())
      expect(after.height).toBeCloseTo(before.height, 0)
      expect(
        (await box(page.locator('article.post .identity .name'))).y,
      ).toBeGreaterThan(before.y)
    })

    test('a banner only the platform has shows from there, without opening', async ({
      page,
    }) => {
      const remoteRequests: string[] = []
      await serve(page, profile(remote), { remoteRequests })
      await page.goto(`/collection/${id}`)
      await expect(page.locator('.cover img')).toHaveAttribute('src', REMOTE)
      await expect(page.locator('.cover img')).toHaveCSS('opacity', '1')
      await expect(page.locator('.cover button')).toHaveCount(0)
      await expectCover(page)
      expect(remoteRequests).toEqual([REMOTE])
    })

    test('a profile without a banner keeps its plain header', async ({
      page,
    }) => {
      await serve(page, profile())
      await page.goto(`/collection/${id}`)
      await expect(page.locator('article.post .identity .name')).toHaveText(
        '山野记录',
      )
      await expect(page.locator('.cover')).toHaveCount(0)
      const avatarBox = await box(
        page.locator('article.post .author > .avatar'),
      )
      expect(avatarBox.width).toBe(44)
    })

    test('a sensitive banner stays out until sensitive media is shown', async ({
      page,
    }) => {
      await serve(page, profile({ ...saved, sensitive: true }))
      await page.goto(`/collection/${id}`)
      await expect(page.locator('article.post .identity .name')).toHaveText(
        '山野记录',
      )
      await expect(page.locator('.cover')).toHaveCount(0)
      await page.getByRole('button', { name: '显示敏感内容' }).click()
      await expect(page.locator('.cover')).toBeVisible()
      await expectCover(page)
    })

    test('a public link shows the banner and opens it', async ({ page }) => {
      // The same page through a link, which answers under /v1/public/<slug>.
      await page.route('https://telegram.org/**', (r) =>
        r.fulfill({ body: '' }),
      )
      await page.route('**/v1/**', (r) => {
        const path = new URL(r.request().url()).pathname
        if (path === '/v1/assets/banner-original')
          return r.fulfill({
            contentType: 'image/svg+xml',
            body: svg(1500, 500, '#a63'),
          })
        if (path.startsWith('/v1/assets/'))
          return r.fulfill({
            contentType: 'image/svg+xml',
            body: svg(600, 200, '#36a'),
          })
        const base = `/v1/public/${slug}`
        if (!path.startsWith(base))
          return r.fulfill({ status: 401, json: { error: '需要登录' } })
        const rest = path.slice(base.length)
        const json =
          rest === ''
            ? { target: 'collection', collection_id: id }
            : rest === `/collections/${id}`
              ? profile(saved)
              : rest.endsWith('/history') || rest.endsWith('/profile-changes')
                ? { items: [] }
                : rest.endsWith('/counts')
                  ? { points: [] }
                  : undefined
        return json === undefined
          ? r.fulfill({ status: 404, json: { error: '内容不存在' } })
          : r.fulfill({ json })
      })
      await page.goto(`/s/${slug}`)
      const cover = page.getByRole('button', { name: '查看山野记录的主页封面' })
      await expect(cover.locator('img')).toHaveAttribute(
        'src',
        '/v1/assets/banner-thumbnail',
      )
      await expectCover(page)
      await cover.click()
      await expect(
        page
          .getByRole('dialog', { name: '图片预览' })
          .locator('.pswp__img')
          .last(),
      ).toHaveAttribute('src', '/v1/assets/banner-original')
    })
  })
}
