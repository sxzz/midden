import { Buffer } from 'node:buffer'
import { expect, test } from './test'

const profileId = '77777777-7777-4777-8777-777777777777'
const postId = '99999999-9999-4999-8999-999999999999'
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
      fields: [
        { field: 'bio', before: '旧简介', after: '合成简介' },
        {
          field: 'pinned',
          before: [],
          after: [
            {
              id: '9',
              url: 'https://x.com/i/web/status/9',
              collection_id: postId,
              text: '置顶的合成帖子',
            },
          ],
        },
      ],
    },
  ],
}
/** Two versions of the profile, the older under its old name. */
const history = {
  items: [
    {
      capture_id: 'capture-3',
      revision_id: 'revision-3',
      observed_at: '2026-11-05T08:00:00Z',
    },
    {
      capture_id: 'capture-1',
      revision_id: 'revision-1',
      observed_at: '2026-11-01T08:00:00Z',
    },
  ],
}
const older = {
  ...profile,
  revision_id: 'revision-1',
  graph: {
    ...profile.graph,
    entities: [
      {
        ...profile.graph.entities[0]!,
        data: { name: '旧名字', username: 'owner', metadata: {} },
      },
    ],
  },
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
    else if (path.endsWith('/history')) json = history
    else if (path.endsWith('/history/capture-1')) json = older
    else if (path.endsWith('/availability')) json = { available: true }
    else if (path.endsWith('/annotation')) json = { note: '', tags: [] }
    else if (path === '/v1/tags') json = []
    else if (path === `/v1/collections/${profileId}`) json = profile
    return route.fulfill({ json })
  })
  await page.goto(`/collection/${profileId}`)
  // The detail shows the profile as it is now; its versions are read on the
  // page of changes.
  await expect(page.locator('.post .name')).toHaveText('合成账号')
  await expect(page.getByRole('slider')).toHaveCount(0)
  // 更新 comes before the pages about the profile, with the date of the
  // version under it.
  const update = page.locator('.section.update')
  await expect(update.locator('.section-footnote')).toHaveText(
    /^最新版本抓取于 /,
  )
  await expect(
    update.locator('xpath=following-sibling::section[1]'),
  ).toContainText('历史')
  await page.getByRole('link', { name: '历史' }).click()
  await expect(page).toHaveURL(new RegExp(`/collection/${profileId}/history$`))
  await expect(page.locator('h1')).toHaveText('历史')
  await expect(
    page.getByRole('navigation', { name: '历史' }).getByRole('link'),
  ).toHaveText(['资料', '数据', '关注'])

  const versions = page.locator('.versions')
  await expect(versions.locator('.name')).toHaveText('合成账号')
  await expect(versions).not.toContainText('保存于')
  await expect(versions).not.toContainText('UID')
  const slider = page.getByRole('slider', { name: '资料版本' })
  await slider.focus()
  await page.keyboard.press('Home')
  await expect(versions.locator('.name')).toHaveText('旧名字')
  await expect(versions.locator('.when')).toContainText('2026年11月1日')
  await page.keyboard.press('End')
  await expect(versions.locator('.name')).toHaveText('合成账号')

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
  // A newly pinned post links to its collection.
  const pinned = entries.nth(1).getByRole('link', { name: '置顶的合成帖子' })
  await expect(pinned).toHaveAttribute('href', `/collection/${postId}`)

  // The sensitive new avatar is covered; a tap uncovers it, the next opens it.
  const covered = latest.getByRole('button', { name: '敏感内容，点按显示' })
  await covered.click()
  await latest.getByRole('button', { name: '放大新头像' }).click()
  await expect(page.locator('dialog.viewer')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('dialog.viewer')).toBeHidden()

  await page.getByRole('link', { name: '返回', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/collection/${profileId}$`))
  await expect(page.locator('h1')).toHaveText('账号')
})
