import { Buffer } from 'node:buffer'
import { expect, test } from '@playwright/test'
import { swipeImage } from './touch'
const id = '11111111-1111-4111-8111-111111111111'
const collection = {
  id,
  url: 'https://example.test/post',
  text: '这是一条保存在 Midden 的测试收藏。',
  author_name: '测试作者',
  published_at: '2026-09-28T10:00:00Z',
  saved_at: '2026-09-29T10:00:00Z',
  observed_at: '2026-09-29T10:00:00Z',
  visibility: 'public',
  revision_id: 'r1',
  assets: [],
  warnings: [],
}
test('browse, filter, history, refresh and remove a saved post', async ({
  page,
}) => {
  let deleted = false
  const captureBodies: unknown[] = []
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', async (r) => {
    const u = new URL(r.request().url())
    const path = u.pathname
    let body: unknown
    switch (path) {
      case '/v1/session': {
        body = { tenant_id: 'fixture' }
        break
      }
      case '/v1/usage': {
        body = {
          used_bytes: 1048576,
          reserved_bytes: 0,
          limit_bytes: 1073741824,
        }
        break
      }
      case '/v1/collections': {
        body = {
          items:
            deleted || u.searchParams.get('q') === '不存在' ? [] : [collection],
        }
        break
      }
      default:
        if (path.endsWith('/availability')) body = { available: true }
        else if (path.endsWith('/revisions'))
          body = {
            items: [
              { id: 'r1', created_at: collection.observed_at },
              { id: 'r0', created_at: '2026-09-27T10:00:00Z' },
            ],
          }
        else if (path.endsWith('/revisions/r0'))
          body = { ...collection, revision_id: 'r0', text: '历史正文' }
        else if (path === '/v1/captures') {
          captureBodies.push(r.request().postDataJSON())
          body = { id: 'job', collection_id: id, state: 'complete' }
        } else if (path === `/v1/collections/${id}`) {
          if (r.request().method() === 'DELETE') {
            deleted = true
            await r.fulfill({ status: 204 })
            return
          }
          body = collection
        } else {
          await r.fulfill({ status: 404, json: { error: 'not found' } })
          return
        }
    }
    await r.fulfill({ json: body })
  })
  const openRow = () =>
    page
      .getByRole('button', { name: /测试作者/ })
      .first()
      .click()
  await page.goto('/app/')
  await expect(page.getByText(collection.text)).toBeVisible()
  await page.screenshot({
    path: 'test-results/library-mobile.png',
    fullPage: true,
  })
  await openRow()
  await expect(page.locator('.post .details')).toContainText('保存于')
  await expect(page.locator('.post .detail').nth(0)).toContainText('发布于')
  await expect(page.locator('.post .detail').nth(1)).toContainText('保存于')
  await expect(
    page.locator('.section-footnote').filter({ hasText: '保存于' }),
  ).toHaveCount(0)
  await page.getByRole('button', { name: '历史版本' }).click()
  await page.getByRole('button', { name: /2026年9月27日/ }).click()
  await expect(page.getByText('历史正文')).toBeVisible()
  await expect(
    page.getByRole('button', { name: /2026年9月27日/ }),
  ).toBeDisabled()
  await page.getByRole('button', { name: /最新版本 ·/ }).click()
  await expect(page.getByText(collection.text)).toBeVisible()
  await expect(page.getByRole('button', { name: /最新版本 ·/ })).toBeDisabled()
  await page.getByRole('button', { name: '重新抓取' }).click()
  await page.getByRole('button', { name: /附加更新/ }).click()
  await expect(page.getByText('已更新。')).toBeVisible()
  expect(captureBodies.at(-1)).toEqual({
    refresh_id: id,
    update_mode: 'append',
  })
  await page.getByRole('button', { name: '返回' }).click()
  await page.getByRole('searchbox').fill('不存在')
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await expect(page.getByText('没有匹配的收藏', { exact: true })).toBeVisible()
  await page.getByRole('searchbox').fill('')
  await page.getByRole('button', { name: '搜索', exact: true }).click()
  await openRow()
  await page.getByRole('button', { name: '删除这条收藏' }).click()
  await page.getByRole('button', { name: '删除', exact: true }).click()
  await expect(page.getByText('暂无收藏', { exact: true })).toBeVisible()
})
test('ordinary browser explains Telegram entry', async ({ page }) => {
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/session', (r) =>
    r.fulfill({ status: 401, json: { error: 'authentication required' } }),
  )
  await page.goto('/app/')
  await expect(
    page.getByText('请从 Telegram Bot 的「打开」进入。'),
  ).toBeVisible()
})

test('sensitive image stays blurred until revealed and opens inside the page', async ({
  page,
}) => {
  let requests = 0
  const sensitive = {
    ...collection,
    assets: [
      {
        id: 'media',
        mime: 'image/png',
        state: 'ready',
        sensitive: true,
        alt_text: '合成测试图片',
      },
    ],
  }
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', async (r) => {
    const path = new URL(r.request().url()).pathname
    if (path.startsWith('/v1/assets/')) {
      requests++
      await r.fulfill({
        contentType: 'image/png',
        body: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=',
          'base64',
        ),
      })
      return
    }
    const body =
      path === '/v1/session'
        ? { tenant_id: 'fixture' }
        : path === '/v1/usage'
          ? { used_bytes: 0, reserved_bytes: 0, limit_bytes: 1000 }
          : path.endsWith('/availability')
            ? { available: true }
            : path === `/v1/collections/${id}`
              ? sensitive
              : { items: [sensitive] }
    await r.fulfill({ json: body })
  })
  await page.goto('/app/')
  // Sensitive thumbnails and detail previews must remain blurred until revealed.
  await expect(page.locator('.thumbs img')).toBeVisible()
  await expect(page.locator('.thumbs img')).toHaveCSS('filter', 'blur(8px)')
  await page
    .getByRole('button', { name: /测试作者/ })
    .first()
    .click()
  await expect(
    page.getByRole('button', { name: '敏感内容，点按显示' }),
  ).toBeVisible()
  await expect(page.locator('.sensitive img')).toHaveCSS('filter', 'blur(18px)')
  await page.getByRole('button', { name: '敏感内容，点按显示' }).click()
  await expect(page.getByAltText('合成测试图片')).toBeVisible()
  await expect(page.getByAltText('合成测试图片')).toHaveCSS('filter', 'none')
  await page.getByRole('button', { name: '放大图片' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('button', { name: '关闭图片' }).click()
  await expect(page.getByRole('dialog')).not.toBeVisible()
  expect(requests).toBeGreaterThan(0)
})

test('loading skeletons, one revision and touch image navigation', async ({
  page,
}) => {
  const media = {
    ...collection,
    assets: [1, 2].map((n) => ({
      id: `image${n}`,
      state: 'ready',
      mime: 'image/png',
      sensitive: false,
      alt_text: `图片${n}`,
    })),
  }
  const { promise: detailGate, resolve: releaseDetail } =
    Promise.withResolvers<void>()
  const { promise: imageGate, resolve: releaseImage } =
    Promise.withResolvers<void>()
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', async (r) => {
    const path = new URL(r.request().url()).pathname
    if (path.startsWith('/v1/assets/')) {
      await imageGate
      return r.fulfill({
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#3390ec"/></svg>',
      })
    }
    if (path === `/v1/collections/${id}`) await detailGate
    const body =
      path === '/v1/session'
        ? {}
        : path.endsWith('/availability')
          ? { available: true }
          : path.endsWith('/revisions')
            ? { items: [{ id: 'r1', created_at: collection.observed_at }] }
            : path === `/v1/collections/${id}`
              ? media
              : path === '/v1/usage'
                ? { used_bytes: 0, reserved_bytes: 0, limit_bytes: 1000 }
                : { items: [media] }
    await r.fulfill({ json: body })
  })
  await page.goto('/app/')
  await page.getByRole('button', { name: /测试作者/ }).click()
  await expect(page.getByRole('status', { name: '正在加载收藏' })).toBeVisible()
  releaseDetail()
  await expect(page.getByRole('button', { name: '无历史版本' })).toBeDisabled()
  await expect(page.locator('.media .skeleton')).toHaveCount(2)
  releaseImage()
  await expect(page.locator('.media .skeleton')).toHaveCount(0)
  await page.getByRole('button', { name: '放大图片' }).first().click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('status')).toHaveText('1 / 2')
  await expect(dialog.getByRole('button', { name: '上一张' })).toBeDisabled()
  await swipeImage(page)
  await expect(dialog.getByRole('status')).toHaveText('2 / 2')
  await expect(dialog.getByRole('button', { name: '下一张' })).toBeDisabled()
  await expect(dialog.getByAltText('图片2')).toHaveCSS('opacity', '1')
  await page.screenshot({ path: 'test-results/viewer-mobile.png' })
  await dialog.getByRole('button', { name: '上一张' }).click()
  await expect(dialog.getByRole('status')).toHaveText('1 / 2')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: '放大图片' }).first(),
  ).toBeFocused()
})

test('scroll loads the next page and retries without losing existing items', async ({
  page,
}) => {
  let attempts = 0
  const cursors: (string | null)[] = []
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', async (r) => {
    const url = new URL(r.request().url())
    if (url.pathname === '/v1/collections') {
      const cursor = url.searchParams.get('cursor')
      cursors.push(cursor)
      if (cursor) {
        attempts++
        if (attempts === 1) {
          await r.fulfill({ status: 500, json: { error: '加载失败' } })
          return
        }
        await r.fulfill({
          json: {
            items: [{ ...collection, id: 'last', text: '最后一条收藏' }],
          },
        })
      } else {
        await r.fulfill({
          json: {
            items: Array.from({ length: 20 }, (_, i) => ({
              ...collection,
              id: String(i),
              text: `收藏编号 ${i + 1}`,
            })),
            next_cursor: 'page-two',
          },
        })
      }
    } else {
      await r.fulfill({
        json:
          url.pathname === '/v1/usage'
            ? {
                used_bytes: 1048576,
                reserved_bytes: 0,
                limit_bytes: 1073741824,
              }
            : {},
      })
    }
  })
  await page.goto('/app/')
  await expect(page.getByText('收藏编号 1', { exact: true })).toBeVisible()
  await expect(page.getByText('已用 1 MB，共 1.0 GB')).toBeInViewport()
  expect(cursors).toEqual([null])
  await page.getByText('收藏编号 20', { exact: true }).scrollIntoViewIfNeeded()
  await expect(page.getByRole('button', { name: '重试加载' })).toBeVisible()
  expect(cursors).toEqual([null, 'page-two'])
  await expect(page.getByText('收藏编号 1', { exact: true })).toBeAttached()
  await page.getByRole('button', { name: '重试加载' }).click()
  await expect(page.getByText('最后一条收藏')).toBeVisible()
  await expect(page.getByRole('button', { name: '重试加载' })).toHaveCount(0)
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  expect(cursors).toEqual([null, 'page-two', 'page-two'])
  await expect(page.getByText('收藏编号 1', { exact: true })).toBeAttached()
})

test('sort selection resets pagination and carries into subsequent pages', async ({
  page,
}) => {
  const requests: string[] = []
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', async (r) => {
    const url = new URL(r.request().url())
    if (url.pathname !== '/v1/collections') {
      await r.fulfill({ json: {} })
      return
    }
    requests.push(url.search)
    const published = url.searchParams.get('sort') === 'published'
    const tail = url.searchParams.has('cursor')
    await r.fulfill({
      json: {
        items: Array.from({ length: tail ? 1 : 20 }, (_, i) => ({
          ...collection,
          id: `${published}-${tail}-${i}`,
          text: `${published ? '发帖' : '采集'}排序 ${tail ? '末页' : i + 1}`,
        })),
        next_cursor: tail ? undefined : 'next-page',
      },
    })
  })
  await page.goto('/app/')
  await expect(page.getByText('采集排序 1', { exact: true })).toBeVisible()
  await page
    .getByRole('combobox', { name: '排序', exact: true })
    .selectOption('published')
  await expect(page.getByText('发帖排序 1', { exact: true })).toBeVisible()
  await expect(page.getByText('采集排序 1', { exact: true })).toHaveCount(0)
  expect(new URLSearchParams(requests.at(-1)).has('cursor')).toBe(false)
  await page.getByText('发帖排序 20', { exact: true }).scrollIntoViewIfNeeded()
  await expect(page.getByText('发帖排序 末页')).toBeVisible()
  await page
    .getByRole('combobox', { name: '排序方向', exact: true })
    .selectOption('asc')
  await expect(page.getByText('发帖排序 1', { exact: true })).toBeVisible()
  const reset = new URLSearchParams(requests.at(-1))
  expect(reset.get('order')).toBe('asc')
  expect(reset.has('cursor')).toBe(false)
  await page.getByText('发帖排序 20', { exact: true }).scrollIntoViewIfNeeded()
  await expect(page.getByText('发帖排序 末页')).toBeVisible()
  const last = new URLSearchParams(requests.at(-1))
  expect(last.get('order')).toBe('asc')
  expect(last.get('sort')).toBe('published')
  expect(last.get('cursor')).toBe('next-page')
})

test('a failed refresh shows a toast every time it is tried', async ({
  page,
}) => {
  let attempts = 0
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (r) => {
    const path = new URL(r.request().url()).pathname
    if (path === '/v1/session') return r.fulfill({ json: { tenant_id: 'x' } })
    if (path === '/v1/captures') {
      attempts++
      return r.fulfill({
        status: 429,
        json: { error: 'capture rate exceeded' },
      })
    }
    if (path.endsWith('/availability'))
      return r.fulfill({ json: { available: true } })
    if (path.endsWith('/revisions')) return r.fulfill({ json: { items: [] } })
    if (path === `/v1/collections/${id}`) return r.fulfill({ json: collection })
    if (path.endsWith('/annotation'))
      return r.fulfill({ json: { note: '', tags: [] } })
    if (path === '/v1/tags') return r.fulfill({ json: [] })
    return r.fulfill({ json: {} })
  })
  await page.goto(`/app/#/collection/${id}`)
  await expect(page.getByText(collection.text)).toBeVisible()
  const toast = page.locator('.toast')
  for (let i = 1; i <= 2; i++) {
    await page.getByRole('button', { name: '重新抓取' }).click()
    await page.getByRole('button', { name: /完整更新/ }).click()
    await expect.poll(() => attempts).toBe(i)
    await expect(toast).toHaveText('操作太频繁，请稍后重试。')
  }
  // The collection stays on screen instead of giving way to an error banner.
  await expect(page.getByText(collection.text)).toBeVisible()
  await expect(page.locator('.banner')).toHaveCount(0)
})
