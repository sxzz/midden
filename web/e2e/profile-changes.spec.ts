import { Buffer } from 'node:buffer'
import { expect, test } from './test'

const profileId = '77777777-7777-4777-8777-777777777777'
const profile = {
  id: profileId,
  url: 'https://example.test/owner',
  observed_at: '2026-11-05T08:00:00Z',
  saved_at: '2026-11-01T08:00:00Z',
  revision_id: 'revision-2',
  author_name: '合成账号',
  text: '合成简介',
  assets: [],
  graph: {
    root: 'profile',
    relations: [],
    entities: [
      {
        key: 'profile',
        type: 'x.profile',
        external_id: '100',
        data: { name: '合成账号', username: 'owner', metadata: {} },
      },
    ],
  },
}
// A 1×1 PNG, so the images load without a media server.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)
const image = (id: string, sensitive = false) => ({
  id,
  purpose: 'avatar',
  position: 0,
  state: 'ready',
  sensitive,
  sha256: id,
  mime: 'image/png',
  size: png.length,
  url: `/media/${id}`,
})
const changes = {
  items: [
    {
      capture_id: 'capture-3',
      revision_id: 'revision-3',
      observed_at: '2026-11-05T08:00:00Z',
      fields: [
        { field: 'name', before: '旧名字', after: '合成账号' },
        { field: 'protected', before: true, after: false },
        { field: 'avatar', before: image('a1'), after: image('a2', true) },
      ],
    },
    {
      capture_id: 'capture-2',
      revision_id: 'revision-2',
      observed_at: '2026-11-02T08:00:00Z',
      fields: [{ field: 'bio', before: '旧简介', after: '合成简介' }],
    },
  ],
}

test('lists a profile’s changes from its detail and returns to it', async ({
  page,
}) => {
  await page.route('https://telegram.org/**', (route) =>
    route.fulfill({ body: '' }),
  )
  await page.route('**/media/**', (route) =>
    route.fulfill({ body: png, contentType: 'image/png' }),
  )
  await page.route('**/v1/**', (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    let json: unknown = {}
    if (path === '/v1/collections') json = { items: [] }
    else if (path.endsWith('/profile-changes')) {
      const limit = Number(url.searchParams.get('limit') || 1000)
      json = { items: changes.items.slice(0, limit) }
    } else if (path.endsWith('/counts')) json = { points: [] }
    else if (path.endsWith('/history')) json = { items: [] }
    else if (path.endsWith('/availability')) json = { available: true }
    else if (path.endsWith('/annotation')) json = { note: '', tags: [] }
    else if (path === '/v1/tags') json = []
    else if (path === `/v1/collections/${profileId}`) json = profile
    return route.fulfill({ json })
  })
  await page.goto(`/app/#/collection/${profileId}`)
  await page.getByRole('link', { name: '资料修改记录' }).click()
  await expect(page).toHaveURL(new RegExp(`/collection/${profileId}/changes$`))
  await expect(page.locator('h1')).toHaveText('资料修改记录')

  const entries = page.locator('.entry')
  await expect(entries).toHaveCount(2)
  const latest = entries.first()
  await expect(latest.locator('.label, .flag')).toHaveText([
    '昵称',
    '取消受保护',
    '头像',
  ])
  await expect(latest.locator('del')).toHaveText('旧名字')
  await expect(latest.locator('ins')).toHaveText('合成账号')
  await expect(entries.nth(1).locator('ins')).toHaveText('合成简介')

  // The sensitive new avatar is covered; a tap uncovers it, the next opens it.
  const covered = latest.getByRole('button', { name: '敏感内容，点按显示' })
  await covered.click()
  await latest.getByRole('button', { name: '放大新头像' }).click()
  await expect(page.locator('dialog.viewer')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('dialog.viewer')).toBeHidden()

  await page.getByRole('link', { name: '返回', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/collection/${profileId}$`))
  await expect(page.locator('h1')).toHaveText('收藏详情')
})
