import { expect, test } from '@playwright/test'

const profileId = '22222222-2222-4222-8222-222222222222'
const mentionedId = '33333333-3333-4333-8333-333333333333'
const postId = '44444444-4444-4444-8444-444444444444'
const quoteId = '55555555-5555-4555-8555-555555555555'
const base = {
  url: 'https://example.test/item',
  observed_at: '2026-09-30T10:00:00Z',
  saved_at: '2026-09-30T10:00:00Z',
  revision_id: 'revision-1',
  assets: [],
}
const mention = {
  key: 'mention',
  type: 'x.profile',
  external_id: 'handle:friend',
  context_only: true,
  saved_collection_id: mentionedId,
  data: { username: 'friend' },
}
const profile = {
  ...base,
  id: profileId,
  author_name: '主账号',
  text: '简介提到 @friend',
  graph: {
    root: 'profile',
    relations: [],
    entities: [
      {
        key: 'profile',
        type: 'x.profile',
        external_id: '100',
        data: { username: 'owner' },
      },
      mention,
    ],
  },
}
const friend = {
  ...base,
  id: mentionedId,
  author_name: '朋友账号',
  text: '朋友的简介',
  graph: {
    root: 'profile',
    relations: [],
    entities: [
      {
        key: 'profile',
        type: 'x.profile',
        external_id: '200',
        data: { username: 'friend' },
      },
    ],
  },
}
const post = {
  ...base,
  id: postId,
  author_name: '主账号',
  text: '相关帖子也提到 @friend',
  storage_bytes: 1024,
  relation_types: ['reposted'],
  graph: {
    root: 'post',
    relations: [{ source: 'post', target: 'quote', type: 'quoted' }],
    entities: [
      { key: 'post', type: 'x.post', external_id: '300', data: {} },
      {
        key: 'quote',
        type: 'x.post',
        external_id: '400',
        saved_collection_id: quoteId,
        data: { text: '合成被引用正文' },
      },
      mention,
    ],
  },
}

const quotedPost = {
  ...base,
  id: quoteId,
  text: '合成被引用正文',
  author_name: '合成原作者',
}

test('profile shows related collection rows and total storage, with internal bio and post mentions', async ({
  page,
}) => {
  const queries: URLSearchParams[] = []
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('https://telegram.org/**', (route) =>
    route.fulfill({ body: '' }),
  )
  await page.route('**/v1/**', (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    let json: unknown
    if (path === '/v1/collections') {
      queries.push(url.searchParams)
      json = {
        items: url.searchParams.get('related_to') === profileId ? [post] : [],
        total_storage_bytes: 2097152,
      }
    } else if (path.endsWith('/revisions')) json = { items: [] }
    else if (path.endsWith('/availability')) json = { available: true }
    else if (path.endsWith('/annotation')) json = { note: '', tags: [] }
    else if (path === '/v1/tags') json = []
    else
      json =
        [profile, friend, post, quotedPost].find(
          (item) => path === `/v1/collections/${item.id}`,
        ) || {}
    return route.fulfill({ json })
  })
  await page.goto(`/app/#/collection/${profileId}`)
  const related = page.getByRole('region', { name: '关联的收藏' })
  await expect(related.getByText('帖子占用总量 2.0 MB')).toBeVisible()
  await expect(related.locator('.row')).toHaveCount(1)
  await expect(related.locator('.row .repost')).toContainText('主账号 已转发')
  await expect(related.locator('.row .relation')).toContainText('引用的帖子')
  await related.locator('.row .relation').click()
  await expect(page).toHaveURL(new RegExp(`/collection/${quoteId}$`))
  await expect(page.locator('.post .body')).toHaveText('合成被引用正文')
  await page.getByRole('button', { name: '返回', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/collection/${profileId}$`))
  await expect(related.locator('.row .preview')).toHaveText(
    '相关帖子也提到 @friend',
  )
  expect(
    queries.some(
      (query) =>
        query.get('related_to') === profileId &&
        query.get('entity_type') === 'x.post',
    ),
  ).toBe(true)
  const album = related.getByRole('button', { name: '相册', exact: true })
  await expect(album).toHaveText('')
  await album.click()
  await expect(album).toHaveAttribute('aria-pressed', 'true')
  await related.getByRole('button', { name: '信息流', exact: true }).click()
  await related.locator('.row').click()
  await expect(page).toHaveURL(new RegExp(`/collection/${postId}$`))
  await expect(page.locator('.post .body')).toHaveText('相关帖子也提到 @friend')
  await page
    .locator('.post .body')
    .getByRole('link', { name: '@friend', exact: true })
    .click()
  await expect(page).toHaveURL(new RegExp(`/collection/${mentionedId}$`))
  await expect(page.locator('.post .body')).toHaveText('朋友的简介')
  await page.goto(`/app/#/collection/${profileId}`)
  await page
    .locator('.post .body')
    .getByRole('link', { name: '@friend', exact: true })
    .click()
  await expect(page).toHaveURL(new RegExp(`/collection/${mentionedId}$`))
  expect(errors).toEqual([])
})

test('profile refresh keeps reloading related posts until its members finish', async ({
  page,
}) => {
  const postN = (n: number) => ({
    ...post,
    id: `66666666-6666-4666-8666-66666666666${n}`,
    text: `新帖子 ${n}`,
    relation_types: [],
    graph: undefined,
  })
  let saved = [postN(1)]
  let polls = 0
  let listLoads = 0
  await page.route('https://telegram.org/**', (route) =>
    route.fulfill({ body: '' }),
  )
  await page.route('**/v1/**', (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    let json: unknown
    switch (path) {
      case '/v1/collections': {
        listLoads++
        json = { items: saved }

        break
      }
      case '/v1/captures': {
        json = { id: 'job', collection_id: profileId, state: 'queued' }
        break
      }
      case '/v1/jobs/job': {
        polls++
        // The profile capture finishes first; its posts land over later polls.
        if (polls === 2) saved = [postN(2), postN(1)]
        if (polls >= 3) saved = [postN(3), postN(2), postN(1)]
        json = {
          id: 'job',
          collection_id: profileId,
          state: 'complete',
          members: {
            total: 2,
            complete: Math.min(polls - 1, 2),
            partial: 0,
            failed: 0,
            pending: Math.max(3 - polls, 0),
            done: polls >= 3,
          },
        }

        break
      }
      default:
        if (path.endsWith('/revisions')) json = { items: [] }
        else if (path.endsWith('/availability')) json = { available: true }
        else if (path.endsWith('/annotation')) json = { note: '', tags: [] }
        else if (path === '/v1/tags') json = []
        else if (path === `/v1/collections/${profileId}`) json = profile
        else json = {}
    }
    return route.fulfill({ json })
  })
  await page.goto(`/app/#/collection/${profileId}`)
  const related = page.getByRole('region', { name: '关联的收藏' })
  await expect(related.locator('.row')).toHaveCount(1)
  await page.getByRole('button', { name: '重新抓取' }).click()
  await expect(page.locator('p.status')).toHaveText(
    /已更新，正在保存帖子（剩余 \d 条）…/,
  )
  // The last reload happens once every member finished, without a manual refresh.
  await expect(page.locator('p.status')).toHaveText(
    '已更新，2 条帖子已保存。',
    { timeout: 15_000 },
  )
  await expect(related.locator('.row')).toHaveCount(3)
  await expect(related.locator('.row').first()).toContainText('新帖子 3')

  // A soft refresh reloads the list in place.
  saved = [postN(4), ...saved]
  const before = listLoads
  await related.getByRole('button', { name: '刷新', exact: true }).click()
  await expect(related.locator('.row')).toHaveCount(4)
  expect(listLoads).toBe(before + 1)
})
