import { expect, test } from '@playwright/test'

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
const record = {
  id: recordId,
  job_id: 'job',
  collection_id: profileId,
  saved: true,
  url: profile.url,
  input: profile.url,
  platform: 'x',
  kind: 'profile',
  state: 'complete',
  media: { total: 0, ready: 0, failed: 0 },
  created_at: '2026-11-05T08:00:00Z',
  finished_at: '2026-11-05T08:01:00Z',
  done: true,
  members: {
    total: 0,
    complete: 0,
    partial: 0,
    failed: 0,
    pending: 0,
    done: true,
  },
  relations: [
    { list: 'following', state: 'complete', expected: 2, fetched: 2 },
    {
      list: 'followers',
      state: 'skipped',
      expected: 20000,
      fetched: 0,
      error: '超过 5000 人，未抓取',
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
      account: { entity_id: 'e2', external_id: '2', username: 'gone' },
    },
  ],
}

test('updates a profile with its lists and lists its follow changes', async ({
  page,
}) => {
  const submitted: unknown[] = []
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
    if (path === '/v1/captures') {
      submitted.push(route.request().postDataJSON())
      return route.fulfill({
        json: {
          id: 'job',
          collection_id: profileId,
          state: 'queued',
          record_id: recordId,
        },
      })
    }
    return route.fulfill({ json: fixed[path] ?? {} })
  })
  await page.goto(`/app/#/collection/${profileId}`)

  // What stored follows say, shown only because there are some.
  const counts = page.locator('dl.follows')
  await expect(counts.locator('dt')).toHaveText(['关注', '粉丝', '互关'])
  await expect(counts.locator('dd')).toHaveText(['2', '3', '1'])

  // 抓关系网 is off until turned on, and goes along with the update: the
  // two, and the update's progress, form a list group of their own.
  const update = page.locator('section.update')
  const lists = update.getByRole('switch', { name: '抓关系网' })
  await expect(lists).not.toBeChecked()
  await expect(update).not.toContainText('打开原文')
  await expect(update).not.toContainText('删除这条收藏')
  await lists.check()
  await update.getByRole('button', { name: '重新抓取' }).click()
  await expect(page.locator('.toast')).toHaveText('已开始重新抓取')
  expect(submitted).toEqual([
    { refresh_id: profileId, options: { relations: true } },
  ])
  // How the lists went is on the update's record.
  await update.getByRole('button', { name: '查看进度' }).click()
  await expect(page).toHaveURL(new RegExp(`/captures/${recordId}$`))
  await expect(
    page.locator('.facts div').filter({ hasText: '关系网' }).locator('dd'),
  ).toHaveText('关注 2 人 · 粉丝 超过 5000 人，未抓取')
  await page.getByRole('button', { name: '返回', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/collection/${profileId}$`))

  await page.getByRole('button', { name: '关注变化' }).click()
  await expect(page).toHaveURL(new RegExp(`/collection/${profileId}/follows$`))
  await expect(page.locator('h1')).toHaveText('关注变化')
  const entry = page.locator('.entry')
  await expect(entry).toHaveCount(1)
  await expect(entry.locator('.note')).toHaveText([/之后$/, /之后$/])
  await expect(entry.locator('.name')).toHaveText(['新朋友', '@gone'])

  await page.getByRole('button', { name: '返回', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/collection/${profileId}$`))
})
