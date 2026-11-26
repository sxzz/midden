import { expect, test } from './test'

const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
const id = '22222222-2222-4222-8222-222222222222'
const post = (removed: boolean) => ({
  id,
  url: 'https://x.com/synthetic/status/2',
  external_id: '2',
  provider_id: 'x',
  revision_id: 'r',
  text: '带视频的帖子',
  text_kind: 'plain',
  adapter_version: '1',
  author_name: '作者',
  warnings: [],
  saved_at: '2026-09-29T10:00:00Z',
  observed_at: '2026-09-29T10:00:00Z',
  created_at: '2026-09-29T10:00:00Z',
  storage_bytes: removed ? 1000 : 5_000_000,
  assets: [
    removed
      ? {
          id: 'video',
          position: 0,
          state: 'removed',
          kind: 'video',
          sensitive: false,
          size: 0,
          thumbnail: true,
          thumbnail_url: PIXEL,
        }
      : {
          id: 'video',
          position: 0,
          state: 'ready',
          kind: 'video',
          sensitive: false,
          size: 5_000_000,
          mime: 'video/mp4',
          url: '/media/video',
        },
  ],
  graph: {
    root: 'post',
    relations: [],
    entities: [
      {
        key: 'post',
        type: 'x.post',
        external_id: '2',
        data: {},
        resource_indices: [0],
      },
    ],
  },
})

test('remove a post’s media, then see it as removed and restore it', async ({
  page,
}) => {
  let removed = false
  const sent: { path: string; body: unknown }[] = []
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/media/video', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (r) => {
    const path = new URL(r.request().url()).pathname
    if (r.request().method() === 'POST')
      sent.push({ path, body: r.request().postDataJSON() })
    if (path === '/v1/session') return r.fulfill({ json: {} })
    if (path === '/v1/usage') return r.fulfill({ json: { used_bytes: 0 } })
    if (path === '/v1/collections')
      return r.fulfill({ json: { items: [post(removed)] } })
    if (path === `/v1/collections/${id}`)
      return r.fulfill({ json: post(removed) })
    if (path.endsWith('/availability'))
      return r.fulfill({ json: { available: true } })
    if (path === '/v1/media-removals/preview')
      return r.fulfill({
        json: { media: 1, freed_bytes: 5_000_000, shared: 0 },
      })
    if (path === '/v1/media-removals') {
      removed = true
      return r.fulfill({
        json: { media: 1, freed_bytes: 5_000_000, shared: 0 },
      })
    }
    if (path === '/v1/media-removals/restore') {
      removed = false
      return r.fulfill({ status: 204 })
    }
    if (path === '/v1/updates') return r.fulfill({ json: { id: 'record' } })
    if (path === '/v1/shares') return r.fulfill({ json: [] })
    if (path.endsWith('/annotation'))
      return r.fulfill({ json: { tags: [], note: '' } })
    if (path === '/v1/tags') return r.fulfill({ json: [] })
    if (path.endsWith('/history') || path === '/v1/folders')
      return r.fulfill({ json: path.endsWith('/history') ? { items: [] } : [] })
    return r.fulfill({ json: {} })
  })
  await page.goto(`/app/#/collection/${id}`)
  await expect(page.getByText('带视频的帖子')).toBeVisible()
  await page.getByRole('button', { name: '删除此帖所有媒体' }).click()
  const sheet = page.getByRole('dialog', { name: '删除此帖所有媒体？' })
  await expect(sheet.getByText('可释放 4.8 MB')).toBeVisible()
  await sheet.getByRole('button', { name: '删除', exact: true }).click()
  // The kept thumbnail, linking to the post on the platform.
  const link = page.getByRole('link', { name: '视频已移除 · 在原站查看 ›' })
  await expect(link).toHaveAttribute('href', 'https://x.com/synthetic/status/2')
  await expect(
    page.getByRole('button', { name: '删除此帖所有媒体' }),
  ).toHaveCount(0)
  // Restoring captures the post again at once.
  await page.getByRole('button', { name: '恢复下载' }).click()
  expect(sent[1]).toEqual({ path: '/v1/media-removals', body: { ids: [id] } })
  await expect
    .poll(() => sent.map((s) => s.path))
    .toEqual([
      '/v1/media-removals/preview',
      '/v1/media-removals',
      '/v1/media-removals/restore',
      '/v1/updates',
    ])
})

test('remove the media of a selection from the 多选 bar', async ({ page }) => {
  const sent: { path: string; body: unknown }[] = []
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (r) => {
    const path = new URL(r.request().url()).pathname
    if (r.request().method() === 'POST')
      sent.push({ path, body: r.request().postDataJSON() })
    if (path === '/v1/session') return r.fulfill({ json: {} })
    if (path === '/v1/usage') return r.fulfill({ json: { used_bytes: 0 } })
    if (path === '/v1/collections')
      return r.fulfill({ json: { items: [post(false)] } })
    if (path.startsWith('/v1/media-removals'))
      return r.fulfill({ json: { media: 1, freed_bytes: 0, shared: 1 } })
    return r.fulfill({ status: 404, json: { error: '内容不存在或已删除' } })
  })
  await page.goto('/app/')
  await expect(page.getByText('带视频的帖子')).toBeVisible()
  await page.getByRole('button', { name: '多选' }).click()
  await page.getByRole('checkbox', { name: /作者/ }).click()
  await page.getByRole('button', { name: '更多操作' }).click()
  await page
    .getByRole('dialog', { name: '已选 1 项' })
    .getByRole('button', { name: '删除媒体' })
    .click()
  const sheet = page.getByRole('dialog', { name: '删除 1 项的媒体？' })
  await expect(sheet.getByText('其他收藏仍在使用，不会释放空间')).toBeVisible()
  await sheet.getByRole('button', { name: '删除', exact: true }).click()
  await expect(page.getByText('已删除 1 个媒体')).toBeVisible()
  expect(sent.slice(0, 2)).toEqual([
    { path: '/v1/media-removals/preview', body: { ids: [id] } },
    { path: '/v1/media-removals', body: { ids: [id] } },
  ])
})

test('remove all videos of a profile, stated first and run as a job', async ({
  page,
}) => {
  const profileId = '33333333-3333-4333-8333-333333333333'
  const profile = {
    ...post(false),
    id: profileId,
    url: 'https://x.com/synthetic',
    text: '合成账号简介',
    author_name: '合成账号',
    storage_bytes: 1000,
    assets: [],
    graph: {
      root: 'profile',
      relations: [],
      entities: [
        {
          key: 'profile',
          type: 'x.profile',
          external_id: '1',
          data: { username: 'synthetic' },
        },
      ],
    },
  }
  const effect = {
    posts: 12,
    videos: 15,
    freed_bytes: 250_000_000,
    shared: 0,
    kept: { listed: 2, saved: 1, annotated: 0, quoted: 0 },
    elsewhere: 1,
  }
  const removal = {
    id: 'removal',
    created_at: '2026-09-29T10:00:00Z',
    removed: 0,
  }
  let state: 'none' | 'queued' | 'complete' = 'none'
  const sent: string[] = []
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (r) => {
    const path = new URL(r.request().url()).pathname
    const method = r.request().method()
    if (method === 'POST') sent.push(path)
    if (path === '/v1/session') return r.fulfill({ json: {} })
    if (path === '/v1/usage') return r.fulfill({ json: { used_bytes: 0 } })
    if (path === `/v1/collections/${profileId}`)
      return r.fulfill({ json: profile })
    if (path.endsWith('/availability'))
      return r.fulfill({ json: { available: true } })
    if (path === `/v1/collections/${profileId}/video-removal/preview`)
      return r.fulfill({ json: effect })
    if (path === `/v1/collections/${profileId}/video-removal`) {
      if (method === 'POST') {
        state = 'queued'
        return r.fulfill({
          status: 202,
          json: { ...removal, state: 'queued' },
        })
      }
      if (state === 'none') return r.fulfill({ json: {} })
      // The job ran meanwhile.
      state = 'complete'
      return r.fulfill({
        json: {
          removal: {
            ...removal,
            state: 'complete',
            effect,
            removed: 15,
            finished_at: '2026-09-29T10:00:05Z',
          },
        },
      })
    }
    if (path === '/v1/shares') return r.fulfill({ json: [] })
    if (path.endsWith('/annotation'))
      return r.fulfill({ json: { tags: [], note: '' } })
    if (path === '/v1/tags' || path === '/v1/folders')
      return r.fulfill({ json: [] })
    if (path === '/v1/collections' || path.endsWith('/history'))
      return r.fulfill({ json: { items: [] } })
    return r.fulfill({ json: {} })
  })
  await page.goto(`/app/#/collection/${profileId}`)
  await expect(page.getByText('合成账号简介')).toBeVisible()
  await page.getByRole('button', { name: '删除所有视频' }).click()
  const sheet = page.getByRole('dialog', { name: '删除所有视频？' })
  await expect(
    sheet.getByText(
      '将删除 12 条帖子的 15 个视频，可释放 238.4 MB（保留 3 条帖子的视频：其他账号也关联 2 条、单独收藏 1 条；另有 1 个视频其他收藏也有，保留）',
    ),
  ).toBeVisible()
  await sheet.getByRole('button', { name: '删除', exact: true }).click()
  await expect(sheet).toBeHidden()
  await expect(
    page.getByRole('button', { name: '正在删除视频…' }),
  ).toBeVisible()
  await expect(page.getByText('已删除 15 个视频')).toBeVisible()
  await expect(page.getByRole('button', { name: '删除所有视频' })).toBeEnabled()
  expect(sent).toEqual([
    `/v1/collections/${profileId}/video-removal/preview`,
    `/v1/collections/${profileId}/video-removal`,
  ])
})
