import { Buffer } from 'node:buffer'
import { expect, test } from './test'

const profileId = '88888888-8888-4888-8888-888888888888'
const friendId = '99999999-9999-4999-8999-999999999999'
const profile = {
  id: profileId,
  url: 'https://x.com/i/user/100',
  observed_at: '2026-11-05T08:00:00Z',
  saved_at: '2026-11-01T08:00:00Z',
  revision_id: 'revision-1',
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
const recordId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const relations = [
  { list: 'following', state: 'complete', expected: 2, fetched: 2 },
  {
    list: 'followers',
    state: 'skipped',
    expected: 20000,
    fetched: 0,
    error: '超过 5000 人，未抓取',
  },
]
/** The update's one record, with the profile's parts. */
const record = {
  id: recordId,
  job_id: 'job',
  collection_id: profileId,
  saved: true,
  url: profile.url,
  input: '',
  platform: 'x',
  kind: 'profile',
  state: 'complete',
  media: { total: 0, ready: 0, failed: 0 },
  created_at: '2026-11-05T08:00:00Z',
  finished_at: '2026-11-05T08:01:00Z',
  done: true,
  members: {
    total: 3,
    complete: 1,
    partial: 0,
    failed: 0,
    pending: 0,
    done: true,
    added: 0,
    updated: 1,
  },
  update: {
    target: 'collection',
    target_id: profileId,
    handle: 'owner',
    posts: 0,
    profiles: 1,
    older: false,
    queued: 0,
    skipped: 0,
  },
  profiles: [
    {
      collection_id: profileId,
      url: profile.url,
      handle: 'owner',
      state: 'complete',
      posts: { total: 0, finished: 0, pending: 0, done: true },
      relations,
    },
  ],
  warnings: [],
  media_items: [],
  reasons: [],
}
const changes = {
  items: [
    {
      type: 'follow',
      observed_at: '2026-11-05T08:00:00Z',
      since: '2026-11-04T08:00:00Z',
      account: {
        entity_id: 'e1',
        external_id: '1',
        name: '新朋友',
        username: 'friend',
        collection_id: friendId,
      },
    },
    {
      type: 'unfollowed_by',
      observed_at: '2026-11-05T08:00:00Z',
      since: '2026-11-04T08:00:00Z',
      account: {
        entity_id: 'e2',
        external_id: '2',
        username: 'gone',
        // Known only from a list: its avatar was never downloaded.
        avatar: {
          id: 'remote-avatar',
          purpose: 'avatar',
          position: 0,
          state: 'failed',
          sensitive: false,
          size: 0,
          remote_url: 'https://pbs.twimg.com/profile_images/2/gone.png',
        },
      },
    },
  ],
}
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

test('updates a profile with its lists and lists its follow changes', async ({
  page,
}) => {
  const submitted: unknown[] = []
  const referers: (string | undefined)[] = []
  await page.route('https://pbs.twimg.com/**', (route) => {
    referers.push(route.request().headers().referer)
    return route.fulfill({ body: PNG, contentType: 'image/png' })
  })
  await page.route('https://telegram.org/**', (route) =>
    route.fulfill({ body: '' }),
  )
  // Fixed answers by path; the rest depend on the request.
  const fixed: Record<string, unknown> = {
    '/v1/collections': { items: [] },
    '/v1/tags': [],
    [`/v1/collections/${profileId}`]: profile,
    [`/v1/collections/${profileId}/follows`]: {
      following: 2,
      followers: 3,
      mutual: 1,
    },
    [`/v1/collections/${profileId}/profile-changes`]: { items: [] },
    [`/v1/collections/${profileId}/counts`]: { points: [] },
    [`/v1/collections/${profileId}/history`]: { items: [] },
    [`/v1/collections/${profileId}/availability`]: { available: true },
    [`/v1/collections/${profileId}/annotation`]: { note: '', tags: [] },
    '/v1/updates/preview': {
      posts: 0,
      profiles: 1,
      listable: 1,
      counts: { following: 2, followers: 20_000 },
      older: false,
    },
    [`/v1/captures/${recordId}`]: record,
    [`/v1/captures/${recordId}/members`]: { items: [] },
  }
  await page.route('**/v1/**', (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    if (path.endsWith('/follow-changes')) {
      const limit = Number(url.searchParams.get('limit') || 1000)
      return route.fulfill({ json: { items: changes.items.slice(0, limit) } })
    }
    if (path === '/v1/updates') {
      submitted.push(route.request().postDataJSON())
      return route.fulfill({ json: record })
    }
    if (path === `/v1/collections/${profileId}/update`)
      return route.fulfill({
        json: submitted.length
          ? { record: { id: recordId, done: true }, older: false }
          : { older: false },
      })
    return route.fulfill({ json: fixed[path] ?? {} })
  })
  await page.goto(`/collection/${profileId}`)

  // What stored follows say, shown only because there are some.
  const counts = page.locator('dl.follows')
  await expect(counts.locator('dt')).toHaveText(['关注', '粉丝', '互关'])
  await expect(counts.locator('dd')).toHaveText(['2', '3', '1'])
  // Each count opens the library's accounts under the 关系 filter.
  await expect(counts.getByRole('link')).toHaveText(['2', '3', '1'])
  const href = await counts
    .getByRole('link', { name: '互关 1，在收藏库中查看' })
    .getAttribute('href')
  expect(href).toMatch(/^\/\?/)
  expect(
    Object.fromEntries(new URLSearchParams(href!.split('?', 2)[1])),
  ).toEqual({
    entity_type: 'x.profile,instagram.profile',
    rel_of: 'x/x.profile/100',
    rel: 'mutual',
  })

  // The update and its progress form a list group of their own; 抓关系网
  // is an option of the sheet the update opens, off until turned on.
  const update = page.locator('section.update')
  await expect(update).not.toContainText('打开原文')
  await expect(update).not.toContainText('删除这条收藏')
  await expect(update).not.toContainText('查看进度')
  await update.getByRole('button', { name: '更新', exact: true }).click()
  const sheet = page.getByRole('dialog', { name: '更新 @owner' })
  const lists = sheet.getByRole('switch', { name: /抓关系网/ })
  await expect(lists).not.toBeChecked()
  await expect(sheet).toContainText(
    '关注2 · 粉丝2万（超过5000，将跳过粉丝名单）',
  )
  await lists.check()
  await sheet.getByRole('button', { name: '开始更新' }).click()
  await expect(page.locator('.toast')).toHaveText('已开始更新')
  expect(submitted).toEqual([
    {
      target: { target: 'collection', id: profileId },
      options: {
        posts: 'latest',
        count: 100,
        media_only: false,
        include_shared: true,
        capture_references: true,
        relations: true,
      },
    },
  ])
  // How each part went is on the update's record.
  await update.getByRole('link', { name: '查看进度' }).click()
  await expect(page).toHaveURL(new RegExp(`/captures/${recordId}$`))
  await expect(page.locator('.summary .title')).toHaveText('更新 @owner')
  // No new posts: 账号 is the first tab, open.
  await expect(page.getByRole('tab', { name: '账号 1' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(page.locator('.profile')).toContainText(
    '资料 ✓ · 帖子0 · 关注 ✓ · 粉丝 跳过',
  )
  await page.getByRole('link', { name: '返回', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/collection/${profileId}$`))

  // 关注变化 is the 关注 tab of the account's 历史.
  await page.getByRole('link', { name: '历史' }).click()
  await page
    .getByRole('navigation', { name: '历史' })
    .getByRole('link', { name: '关注' })
    .click()
  await expect(page).toHaveURL(
    new RegExp(`/collection/${profileId}/history/follows$`),
  )
  await expect(page.locator('h1')).toHaveText('历史')
  const entry = page.locator('.entry')
  await expect(entry).toHaveCount(1)
  await expect(entry.locator('.note')).toHaveText([/之后$/, /之后$/])
  await expect(entry.locator('.name')).toHaveText(['新朋友', '@gone'])
  // X's own copy of an avatar never saved here, asked for without a referrer.
  const remote = entry.locator('.avatar img')
  await expect(remote).toHaveAttribute(
    'src',
    'https://pbs.twimg.com/profile_images/2/gone.png',
  )
  await expect(remote).toHaveAttribute('referrerpolicy', 'no-referrer')
  await expect.poll(() => referers.length).toBeGreaterThan(0)
  expect(referers.every((referer) => !referer)).toBe(true)

  await page.getByRole('link', { name: '返回', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/collection/${profileId}$`))
})
