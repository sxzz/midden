import { Buffer } from 'node:buffer'
import { expect, test } from './test'

const post = {
  id: 'aaaa',
  url: 'https://x.com/example/status/1',
  text: '第一行内容\n第二行内容\n第三行内容\n第四行内容',
  author_name: '测试作者',
  observed_at: '2026-10-01T00:00:00Z',
  revision_id: 'r1',
  assets: [
    {
      id: 'image',
      url: '/v1/assets/image?inline=1',
      state: 'ready',
      mime: 'image/png',
      sensitive: false,
    },
  ],
  graph: {
    root: 'post',
    entities: [
      { key: 'post', type: 'x.post', data: {} },
      {
        key: 'author',
        type: 'x.profile',
        saved_collection_id: 'bbbb',
        data: { name: '测试作者' },
        assets: [
          {
            id: 'avatar',
            url: '/v1/assets/avatar?inline=1',
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
}

test('restores sort controls and opens author links in a new tab', async ({
  page,
  context,
}) => {
  await context.route('**/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname
    return route.fulfill({
      json:
        path === '/v1/tags'
          ? []
          : path === '/v1/collections'
            ? { items: [post] }
            : path === '/v1/collections/aaaa'
              ? post
              : path === '/v1/collections/aaaa/history'
                ? { items: [] }
                : {},
    })
  })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/?sort=published&order=asc')
  const sort = page.getByRole('combobox', { name: '排序', exact: true })
  await expect(
    page.getByRole('link', { name: 'Home', exact: true }),
  ).toHaveCount(0)
  // A box takes its media's shape: 180px to within a width's rounding.
  await expect
    .poll(async () => (await page.locator('.thumbs').boundingBox())?.height)
    .toBeCloseTo(180, 0)
  await expect(page.locator('.avatar-link')).toHaveCSS('height', '40px')
  await expect(sort).toHaveValue('published')
  // The desktop column, between the rail and the sidebar: wider from 1280px.
  expect(await page.locator('.page').evaluate((el) => el.clientWidth)).toBe(680)
  await page.screenshot({
    path: 'test-results/library-desktop.png',
    fullPage: true,
  })
  await page.reload()
  await expect(sort).toHaveValue('published')
  await expect(page.getByRole('combobox', { name: '排序方向' })).toHaveValue(
    'asc',
  )
  const opened = context.waitForEvent('page')
  await page.locator('.avatar-link').click({ modifiers: ['ControlOrMeta'] })
  const tab = await opened
  await expect(tab).toHaveURL(/\/collection\/bbbb$/)
  await tab.close()
  await page.locator('.head').click()
  await expect(page).toHaveURL(/\/collection\/aaaa$/)
  await expect(page.locator('.post .avatar[href]')).toHaveAttribute(
    'href',
    '/collection/bbbb',
  )
  // 返回 goes to the list as it was left; 探索, the open tab, resets it.
  await expect(
    page.getByRole('link', { name: '返回', exact: true }),
  ).toHaveAttribute('href', '/?sort=published&order=asc')
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name: '探索' })
    .click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('combobox', { name: '排序方向' })).toHaveValue(
    'desc',
  )
})

test('authors load with skeletons once their list opens; post type filters update the request', async ({
  page,
}) => {
  const { promise: pending, resolve: finishAuthors } =
    Promise.withResolvers<void>()
  let query = new URLSearchParams()
  let authorRequests = 0
  await page.route('**/v1/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/v1/collections/authors') {
      authorRequests++
      await pending
      return route.fulfill({ json: { items: [] } })
    }
    if (url.pathname === '/v1/collections') query = url.searchParams
    return route.fulfill({
      json: url.pathname === '/v1/tags' ? [] : { items: [] },
    })
  })
  await page.goto('/')
  await page.getByRole('button', { name: /^筛选/ }).click()
  // Opening the panel alone does not fetch authors.
  await expect(page.locator('summary[aria-label="作者"]')).toBeVisible()
  expect(authorRequests).toBe(0)
  await page.locator('summary[aria-label="作者"]').click()
  const skeleton = page.locator('.multi-select .skeleton')
  await expect(skeleton).toBeVisible()
  await expect(skeleton).toHaveText('')
  finishAuthors()
  await expect(skeleton).toHaveCount(0)
  expect(authorRequests).toBe(1)
  await page.getByRole('combobox', { name: '帖子类型' }).selectOption('quote')
  await expect.poll(() => query.get('post_type')).toBe('quote')
})

test('album captions and the media viewer link the post text to its detail', async ({
  page,
}) => {
  await page.route('**/v1/**', (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.startsWith('/v1/assets/'))
      return route.fulfill({
        contentType: 'image/png',
        body: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1kAAAAASUVORK5CYII=',
          'base64',
        ),
      })
    return route.fulfill({
      json:
        path === '/v1/tags'
          ? []
          : path === '/v1/collections'
            ? { items: [post] }
            : path === '/v1/collections/aaaa'
              ? post
              : path.endsWith('/availability')
                ? { available: true }
                : path.endsWith('/history')
                  ? { items: [] }
                  : {},
    })
  })
  await page.goto('/?layout=album')
  await expect(page.locator('.caption-text')).toContainText('第一行内容')
  await page.locator('.album .tile').click()
  const viewer = page.getByRole('dialog')
  // The author and the text are one link to the post; the text is cut to a
  // few lines, and the post has the rest.
  const caption = viewer.locator('.post-caption')
  await expect(caption).toContainText('测试作者')
  await expect(caption).toHaveAttribute('href', '/collection/aaaa')
  await expect(viewer.locator('.caption-avatar img')).toBeVisible()
  await expect(viewer.locator('.caption-body')).toHaveCSS(
    '-webkit-line-clamp',
    '3',
  )
  await caption.click()
  await expect(page).toHaveURL(/\/collection\/aaaa$/)
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('capture options are submitted with links, summed up while folded', async ({
  page,
}) => {
  let body: any
  await page.route('**/v1/**', (route) => {
    if (route.request().method() === 'POST') {
      body = route.request().postDataJSON()
      return route.fulfill({ json: { id: 'job' } })
    }
    return route.fulfill({ json: { items: [] } })
  })
  await page.goto('/captures')
  await page.getByLabel('链接', { exact: true }).fill('https://x.com/example')
  const options = page.locator('.capture-options')
  await expect(options.locator('summary')).toContainText('最新100条')
  await options.locator('summary').click()
  await page.getByLabel('仅采集含图片或视频的帖子').check()
  await page.getByLabel('包含引用转帖和纯转发').uncheck()
  await page.getByLabel('采集引用、转发的原帖').uncheck()
  await page.getByLabel('帖子范围').selectOption('max')
  await page.getByLabel('条数').fill('42')
  await page.getByLabel('条数').blur()
  await page.getByLabel('发帖日期').selectOption('7')
  await page.getByLabel(/抓关系网/).check()
  // A parent turned off hides its own options.
  await page.getByLabel('抓帖子').uncheck()
  await expect(page.getByLabel('帖子范围')).toHaveCount(0)
  await page.getByLabel('抓帖子').check()
  await expect(page.getByLabel('帖子范围')).toHaveValue('max')
  await options.locator('summary').click()
  await expect(options.locator('summary')).toContainText(
    '最多42条 · 仅媒体 · 不含转帖 · 不抓原帖 · 最近7天 · 抓关系网',
  )
  await page.getByRole('button', { name: '采集', exact: true }).click()
  await expect.poll(() => body?.options?.count).toBe(42)
  expect(body.options).toEqual({
    posts: 'max',
    count: 42,
    since_days: 7,
    media_only: true,
    include_shared: false,
    capture_references: false,
    relations: true,
  })
})

for (const [width, homeHeight, profileHeight] of [
  [390, 120, 180],
  [1440, 180, 260],
]) {
  test(`attachment sizes at viewport ${width}`, async ({ page }) => {
    await page.setViewportSize({ width: width!, height: 900 })
    await page.route('**/v1/**', (route) => {
      const path = new URL(route.request().url()).pathname
      return route.fulfill({
        json:
          path === '/v1/tags'
            ? []
            : path === '/v1/collections'
              ? { items: [post] }
              : path === '/v1/collections/bbbb'
                ? {
                    ...post,
                    id: 'bbbb',
                    assets: [],
                    graph: {
                      root: 'profile',
                      entities: [
                        {
                          key: 'profile',
                          type: 'x.profile',
                          data: { name: '测试作者', description: '简介' },
                        },
                      ],
                      relations: [],
                    },
                  }
                : path === '/v1/collections/aaaa'
                  ? post
                  : { items: [] },
      })
    })
    await page.goto('/')
    // A box takes its media's shape, so its height is the size to within
    // the rounding of its width.
    const height = (selector: string) => async () =>
      (await page.locator(selector).boundingBox())?.height ?? 0
    await expect.poll(height('.thumbs')).toBeCloseTo(homeHeight!, 0)
    await page.locator('.avatar-link').click()
    await expect.poll(height('.related .thumbs')).toBeCloseTo(profileHeight!, 0)
  })
}
