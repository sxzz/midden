import { Buffer } from 'node:buffer'
import { expect, test } from '@playwright/test'

const post = {
  id: 'aaaa',
  url: 'https://x.com/example/status/1',
  text: '第一行内容\n第二行内容\n第三行内容\n第四行内容',
  author_name: '测试作者',
  observed_at: '2026-10-01T00:00:00Z',
  revision_id: 'r1',
  visibility: 'public',
  assets: [
    { id: 'image', state: 'ready', mime: 'image/png', sensitive: false },
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
              : {},
    })
  })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('/app/#/?sort=published&order=asc')
  const sort = page.getByRole('combobox', { name: '排序', exact: true })
  await expect(sort).toHaveValue('published')
  expect(await page.locator('.page').evaluate((el) => el.clientWidth)).toBe(960)
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
  await expect(tab).toHaveURL(/#\/collection\/bbbb$/)
  await tab.close()
  await page.locator('.head').click()
  await expect(page).toHaveURL(/#\/collection\/aaaa$/)
  await expect(page.locator('.post .avatar[href]')).toHaveAttribute(
    'href',
    '#/collection/bbbb',
  )
  await page.getByRole('link', { name: 'Home', exact: true }).click()
  await expect(page).toHaveURL(/#\/$/)
})

test('author loading uses skeletons and post type filters update the request', async ({
  page,
}) => {
  const { promise: pending, resolve: finishAuthors } =
    Promise.withResolvers<void>()
  let query = new URLSearchParams()
  await page.route('**/v1/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/v1/collections/authors') {
      await pending
      return route.fulfill({ json: { items: [] } })
    }
    if (url.pathname === '/v1/collections') query = url.searchParams
    return route.fulfill({
      json: url.pathname === '/v1/tags' ? [] : { items: [] },
    })
  })
  await page.goto('/app/')
  await page.getByRole('button', { name: /^筛选/ }).click()
  await expect(page.locator('.author-skeleton')).toBeVisible()
  await expect(page.locator('.author-skeleton')).toHaveText('')
  finishAuthors()
  await expect(page.locator('.author-skeleton')).toHaveCount(0)
  await page.getByRole('combobox', { name: '帖子类型' }).selectOption('quote')
  await expect.poll(() => query.get('post_type')).toBe('quote')
})

test('album captions and the media viewer include expandable post text', async ({
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
            : {},
    })
  })
  await page.goto('/app/#/?layout=album')
  await expect(page.locator('.caption-text')).toContainText('第一行内容')
  await page.locator('.album .tile').click()
  const viewer = page.getByRole('dialog')
  await expect(viewer.locator('.post-caption')).toContainText('测试作者')
  const body = viewer.locator('.caption-body')
  await expect(body).toHaveAttribute('aria-expanded', 'false')
  await body.click()
  await expect(body).toHaveAttribute('aria-expanded', 'true')
  await expect(body).toContainText('第四行内容')
  await viewer.getByRole('button', { name: '关闭图片' }).click()
})

test('capture options are submitted with links', async ({ page }) => {
  let body: any
  await page.route('**/v1/**', (route) => {
    if (route.request().method() === 'POST') {
      body = route.request().postDataJSON()
      return route.fulfill({ json: { id: 'job' } })
    }
    return route.fulfill({ json: { items: [] } })
  })
  await page.goto('/app/#/captures')
  await page.getByLabel('链接', { exact: true }).fill('https://x.com/example')
  await page.locator('.capture-options summary').click()
  await page.getByLabel('仅采集含图片或视频的帖子').check()
  await page.getByLabel('包含引用转帖和纯转发').uncheck()
  await page.getByLabel('采集引用、转发的原帖').uncheck()
  await page.getByLabel('最多采集帖子', { exact: true }).fill('42')
  await page.getByLabel('采集发帖日期').selectOption('7')
  await page.getByRole('button', { name: '采集', exact: true }).click()
  await expect.poll(() => body?.options?.max_posts).toBe(42)
  expect(body.options).toMatchObject({
    media_only: true,
    omit_shared: true,
    skip_references: true,
  })
  expect(Date.parse(body.options.since)).toBeLessThan(Date.now() - 6 * 86400000)
})
