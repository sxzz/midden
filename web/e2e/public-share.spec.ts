import { Buffer } from 'node:buffer'
import { expect, test } from '@playwright/test'

const slug = 'AbCdEfGhIjKlMnOpQrStUv_-'
const postId = '11111111-1111-4111-8111-111111111111'
const profileId = '22222222-2222-4222-8222-222222222222'
// A 1×1 PNG, so the images load without a media server.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)
const author = {
  key: 'author',
  type: 'x.profile',
  external_id: '100',
  data: { name: '公开作者', username: 'writer' },
  saved_collection_id: profileId,
}
const post = {
  id: postId,
  url: 'https://x.com/writer/status/1',
  external_id: '1',
  provider_id: 'x',
  revision_id: 'revision-1',
  text: '公开的帖子',
  text_kind: 'plain',
  adapter_version: '1',
  warnings: [],
  observed_at: '2026-11-05T08:00:00Z',
  created_at: '2026-11-01T08:00:00Z',
  assets: [
    {
      id: 'sensitive',
      position: 0,
      state: 'ready',
      sensitive: true,
      sha256: 'sensitive',
      mime: 'image/png',
      size: png.length,
      url: '/media/sensitive',
    },
  ],
  graph: {
    root: 'post',
    entities: [
      {
        key: 'post',
        type: 'x.post',
        external_id: '1',
        data: {},
        resource_indices: [0],
      },
      author,
    ],
    relations: [{ source: 'post', target: 'author', type: 'authored_by' }],
  },
}
const profile = {
  ...post,
  id: profileId,
  url: 'https://x.com/writer',
  text: '作者简介',
  assets: [],
  graph: {
    root: 'author',
    entities: [{ ...author, saved_collection_id: undefined }],
    relations: [],
  },
}

test('a public link opens a folder and its items without login', async ({
  page,
}) => {
  const requested: string[] = []
  const lists: URLSearchParams[] = []
  // A visitor's page never asks telegram.org for anything.
  const telegram: string[] = []
  await page.route('https://telegram.org/**', (route) => {
    telegram.push(route.request().url())
    return route.fulfill({ body: '' })
  })
  await page.route('**/media/**', (route) =>
    route.fulfill({ body: png, contentType: 'image/png' }),
  )
  await page.route('**/v1/**', (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    requested.push(path)
    const base = `/v1/public/${slug}`
    if (!path.startsWith(base))
      return route.fulfill({ status: 401, json: { error: '需要登录' } })
    const rest = path.slice(base.length)
    if (rest === '/collections') lists.push(url.searchParams)
    const answers: Record<string, unknown> = {
      '': { target: 'folder', name: '公开收藏夹', posts: 1, profiles: 0 },
      '/collections': { items: [post] },
      [`/collections/${postId}`]: post,
      [`/collections/${profileId}`]: profile,
    }
    const json =
      answers[rest] ??
      (rest.endsWith('/history') || rest.endsWith('/profile-changes')
        ? { items: [] }
        : rest.endsWith('/counts')
          ? { points: [] }
          : undefined)
    if (json === undefined)
      return route.fulfill({ status: 404, json: { error: '内容不存在' } })
    return route.fulfill({ json })
  })

  await page.goto(`/app/#/s/${slug}`)
  await expect(page.locator('h1')).toHaveText('公开收藏夹')
  await expect(page.getByText('公开的帖子')).toBeVisible()
  await expect(page.getByRole('button', { name: '批量更新' })).toHaveCount(0)
  // Sensitive media starts covered for a visitor.
  await expect(
    page.getByRole('button', { name: '敏感内容，点按显示' }).first(),
  ).toBeVisible()

  // The visitor filters and orders the list, newest posts first by default,
  // with no tags; the choice is kept in the address.
  expect(lists[0]?.get('sort')).toBe('published')
  await expect(page.getByLabel('排序', { exact: true })).toHaveValue(
    'published',
  )
  await page.getByRole('button', { name: '筛选' }).click()
  await expect(page.getByText('帖子类型')).toBeVisible()
  await expect(page.getByText('标签')).toHaveCount(0)
  await page.getByLabel('排序', { exact: true }).selectOption('updated')
  await expect(page).toHaveURL(/sort=updated/)
  await expect.poll(() => lists.at(-1)?.get('sort')).toBe('updated')
  await page.reload()
  await expect(page.getByLabel('排序', { exact: true })).toHaveValue('updated')

  await page.getByText('公开的帖子').click()
  await expect(page).toHaveURL(new RegExp(`#/s/${slug}/collection/${postId}$`))
  await expect(page.locator('h1')).toHaveText('收藏详情')
  for (const action of ['重新抓取', '删除这条收藏', '公开分享', '我的整理'])
    await expect(page.getByText(action)).toHaveCount(0)

  // The author is shared too, so its link stays inside the share.
  await page.locator('a.profile-link').click()
  await expect(page).toHaveURL(
    new RegExp(`#/s/${slug}/collection/${profileId}$`),
  )
  await expect(page.getByText('作者简介')).toBeVisible()

  await page.getByRole('button', { name: '返回', exact: true }).click()
  await page.getByRole('button', { name: '返回', exact: true }).click()
  await expect(page.locator('h1')).toHaveText('公开收藏夹')
  expect(requested.every((path) => path.startsWith('/v1/public/'))).toBe(true)
  expect(telegram).toEqual([])
})

test('a revoked link says so', async ({ page }) => {
  await page.route('https://telegram.org/**', (route) =>
    route.fulfill({ body: '' }),
  )
  await page.route('**/v1/**', (route) =>
    route.fulfill({ status: 404, json: { error: '内容不存在或已删除' } }),
  )
  await page.goto(`/app/#/s/${slug}`)
  await expect(page.getByRole('alert')).toHaveText('链接不存在或已取消公开')
})
