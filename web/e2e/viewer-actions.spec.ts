import { Buffer } from 'node:buffer'
import { expect, test, type Page } from './test'

const id = '11111111-1111-4111-8111-111111111111'
const slug = 'AbCdEfGhIjKlMnOpQrStUv_-'
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)
const post = {
  id,
  url: 'https://x.com/writer/status/1',
  external_id: '1',
  provider_id: 'x',
  revision_id: 'r1',
  text: '同一组操作',
  text_kind: 'plain',
  adapter_version: '1',
  author_name: '作者',
  warnings: [],
  observed_at: '2026-11-05T08:00:00Z',
  created_at: '2026-11-01T08:00:00Z',
  assets: ['a', 'b'].map((key, position) => ({
    id: key,
    position,
    state: 'ready',
    kind: 'image',
    sensitive: false,
    mime: 'image/png',
    size: png.length,
    url: `/media/${key}`,
  })),
  graph: {
    root: 'post',
    entities: [
      { key: 'post', type: 'x.post', external_id: '1', data: {} },
      { key: 'author', type: 'x.profile', external_id: '2', data: {} },
    ],
    relations: [{ source: 'post', target: 'author', type: 'authored_by' }],
  },
}

async function mock(page: Page) {
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/media/**', (r) =>
    r.fulfill({ body: png, contentType: 'image/png' }),
  )
  await page.route('**/v1/**', (r) => {
    const path = new URL(r.request().url()).pathname
    const base = `/v1/public/${slug}`
    const rest = path.startsWith(base) ? path.slice(base.length) : path
    const answers: Record<string, unknown> = {
      '': { target: 'folder', name: '公开收藏夹', posts: 1, profiles: 0 },
      '/v1/session': {},
      '/v1/usage': { used_bytes: 0 },
      '/v1/tags': [],
      '/v1/folders': [],
      '/collections': { items: [post] },
      '/v1/collections': { items: [post] },
      '/collections/count': { count: 1, types: { 'x.post': 1 } },
      [`/collections/${id}`]: post,
      [`/v1/collections/${id}`]: post,
      [`/v1/collections/${id}/availability`]: { available: true },
      [`/v1/collections/${id}/annotation`]: { tags: [], note: '' },
    }
    const json =
      answers[rest] ??
      (rest.endsWith('/history') ? { items: [] } : undefined) ??
      (rest.startsWith('/v1/') ? {} : undefined)
    if (json === undefined) return r.fulfill({ status: 404, json: {} })
    return r.fulfill({ json })
  })
}

/** The names of the buttons and links in the viewer's action capsule. */
async function actions(page: Page) {
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByAltText('收藏图片').first()).toBeVisible()
  const toolbar = dialog.getByRole('toolbar', { name: '操作' })
  return toolbar
    .locator('a, button')
    .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')))
}

const owner = ['查看帖子', '下载', '更多']
const visitor = ['查看帖子', '下载']

test('the owner’s viewer has the same actions from the list, the album and the post', async ({
  page,
}) => {
  await mock(page)
  // The list.
  await page.goto('/app/')
  await page.getByRole('button', { name: '放大图片' }).first().click()
  expect(await actions(page)).toEqual(owner)
  await page.keyboard.press('Escape')
  // The album.
  await page.goto('/app/?layout=album')
  await page.locator('.album .tile').first().click()
  expect(await actions(page)).toEqual(owner)
  await page.keyboard.press('Escape')
  // The post's own page.
  await page.goto(`/app/collection/${id}`)
  await page.getByRole('button', { name: '放大图片' }).first().click()
  expect(await actions(page)).toEqual(owner)
  // The menu holds the removal, and the same one from here as anywhere.
  await page.getByRole('dialog').getByRole('button', { name: '更多' }).click()
  await expect(page.getByRole('menuitem', { name: '删除此媒体' })).toBeVisible()
})

test('a visitor’s viewer has the same reduced actions on a shared list and post', async ({
  page,
}) => {
  await mock(page)
  await page.goto(`/app/s/${slug}`)
  await page.getByRole('button', { name: '放大图片' }).first().click()
  expect(await actions(page)).toEqual(visitor)
  await page.keyboard.press('Escape')
  await page.goto(`/app/s/${slug}/collection/${id}`)
  await page.getByRole('button', { name: '放大图片' }).first().click()
  expect(await actions(page)).toEqual(visitor)
})
