import { expect, test } from './test'

const post = '11111111-1111-4111-8111-111111111111'
const profile = '22222222-2222-4222-8222-222222222222'
const retried = '33333333-3333-4333-8333-333333333333'
const collection = '44444444-4444-4444-8444-444444444444'
const record = (patch: Record<string, unknown>) => ({
  id: post,
  job_id: `job-${patch.id ?? post}`,
  collection_id: collection,
  saved: true,
  url: 'https://x.com/fixture/status/1',
  input: 'https://fxtwitter.com/fixture/status/1',
  platform: 'x',
  kind: 'post',
  state: 'queued',
  media: { total: 0, ready: 0, failed: 0 },
  created_at: '2026-10-14T08:00:00Z',
  done: false,
  ...patch,
})
const detail = (patch: Record<string, unknown>) => ({
  ...record(patch),
  warnings: [],
  media_items: [],
  reasons: [],
  ...patch,
})

test('submits links and follows the record until it finishes', async ({
  page,
}) => {
  const submitted: unknown[] = []
  let records: ReturnType<typeof record>[] = []
  let polls = 0
  let listReloads = 0
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (r) => {
    const request = r.request()
    const path = new URL(request.url()).pathname
    if (path === '/v1/session') return r.fulfill({ json: {} })
    if (path === '/v1/collections') {
      listReloads++
      return r.fulfill({ json: { items: [] } })
    }
    if (path === '/v1/captures' && request.method() === 'POST') {
      const body = request.postDataJSON()
      submitted.push(body)
      if (body.url.includes('unsupported.test'))
        return r.fulfill({ status: 400, json: { error: '不支持的链接' } })
      records = [
        record({
          state: 'downloading',
          media: { total: 4, ready: 1, failed: 0 },
        }),
      ]
      return r.fulfill({ status: 202, json: { id: 'job', state: 'queued' } })
    }
    if (path === '/v1/captures') {
      // The capture finishes one poll after it was submitted.
      if (records.length && ++polls > 1)
        records = [
          record({
            state: 'partial',
            done: true,
            media: { total: 4, ready: 3, failed: 1 },
          }),
        ]
      return r.fulfill({ json: { items: records } })
    }
    if (path === `/v1/captures/${post}`)
      return r.fulfill({
        json: detail({
          state: 'partial',
          done: true,
          media: { total: 4, ready: 3, failed: 1 },
          warnings: ['部分资源类型不支持或资源数量超过限制'],
          media_items: [
            { position: 0, kind: 'image', state: 'ready' },
            {
              position: 1,
              kind: 'video',
              state: 'failed',
              error: '请求超时',
            },
          ],
        }),
      })
    return r.fulfill({ status: 404, json: { error: '内容不存在或已删除' } })
  })
  await page.goto('/app/')
  await page.getByRole('link', { name: '采集', exact: true }).click()
  await expect(page.locator('h1')).toHaveText('采集')
  // An empty list says nothing once loaded.
  await expect.poll(() => listReloads).toBeGreaterThan(0)
  await expect(page.getByText(/暂无/)).toHaveCount(0)
  const before = listReloads

  const submit = page.getByRole('button', { name: /^采集/ })
  await expect(submit).toBeDisabled()
  await page
    .getByLabel('链接')
    .fill(
      'fxtwitter.com/fixture/status/1 和 https://unsupported.test/a 两条链接',
    )
  await expect(submit).toHaveText('采集 2 条')
  await submit.click()
  await expect(page.getByRole('alert')).toHaveText(
    '已提交 1 条，1 条未提交：不支持的链接',
  )
  expect(submitted).toEqual([
    { url: 'https://fxtwitter.com/fixture/status/1', options: {} },
    { url: 'https://unsupported.test/a', options: {} },
  ])
  // The link that failed stays to be corrected.
  await expect(page.getByLabel('链接')).toHaveValue(
    'https://unsupported.test/a',
  )

  const row = page.getByRole('link', { name: /x\.com\/fixture\/status\/1/ })
  await expect(row).toContainText('正在保存媒体')
  await expect(row).toContainText('媒体 1/4')
  await expect(row.getByRole('progressbar')).toHaveAttribute('value', '0.25')
  // Polling picks up the finished capture without a reload.
  await expect(row).toContainText('部分缺失')
  await expect(row).toContainText('媒体 3/4 · 失败 1')
  await expect(row.getByRole('progressbar')).toHaveCount(0)

  await row.click()
  await expect(page.locator('h1')).toHaveText('采集记录')
  const reasons = page.locator('section').filter({
    has: page.getByRole('heading', { name: '失败原因', exact: true }),
  })
  await expect(reasons).toContainText('部分资源类型不支持或资源数量超过限制')
  await expect(reasons).toContainText('请求超时')
  const media = page.locator('section').filter({
    has: page.getByRole('heading', { name: '未保存的媒体', exact: true }),
  })
  await expect(media).toContainText('视频 2')
  await expect(media).not.toContainText('图片 1')
  await media.getByRole('button', { name: '显示全部 2 项' }).click()
  await expect(page.getByText('图片 1')).toBeVisible()

  // Finished captures changed the library, so its list loads again.
  await page.getByRole('button', { name: '返回' }).click()
  await page.getByRole('button', { name: '返回' }).click()
  await expect(page.locator('h1')).toHaveText('我的收藏')
  await expect.poll(() => listReloads).toBeGreaterThan(before)
})

test('shows collection progress, member failures, stop and retry', async ({
  page,
}) => {
  const members = {
    total: 3,
    complete: 1,
    partial: 0,
    failed: 1,
    pending: 1,
    done: false,
  }
  let current = detail({
    id: profile,
    kind: 'profile',
    url: 'https://x.com/fixture',
    state: 'complete',
    members,
    reasons: [{ reason: '帖子不存在或已删除', count: 1 }],
    media: { total: 2, ready: 2, failed: 0 },
    media_items: [
      { position: 0, kind: 'image', purpose: 'avatar', state: 'ready' },
      { position: 1, kind: 'image', purpose: 'banner', state: 'ready' },
    ],
  })
  const memberQueries: string[] = []
  const posted: string[] = []
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (r) => {
    const request = r.request()
    const url = new URL(request.url())
    const path = url.pathname
    if (path === '/v1/session') return r.fulfill({ json: {} })
    if (path === '/v1/collections') return r.fulfill({ json: { items: [] } })
    if (path === `/v1/captures/${profile}/members`) {
      const state = url.searchParams.get('state') || ''
      memberQueries.push(state)
      const failed = {
        job_id: 'member-failed',
        collection_id: collection,
        saved: true,
        url: 'https://x.com/fixture/status/2',
        state: 'failed',
        error: '帖子不存在或已删除',
        reasons: [],
        created_at: '2026-10-14T08:00:01Z',
      }
      const complete = {
        ...failed,
        job_id: 'member-complete',
        url: 'https://x.com/fixture/status/3',
        state: 'complete',
        error: undefined,
      }
      // The source reported this one deleted, so it cannot be retried.
      const gone = {
        ...failed,
        job_id: 'member-gone',
        url: 'https://x.com/fixture/status/4',
        gone: true,
      }
      return r.fulfill({
        json: {
          items: state ? [failed, gone] : [failed, complete, gone],
        },
      })
    }
    if (path === `/v1/captures/${profile}/stop`) {
      posted.push('stop')
      current = {
        ...current,
        stopped: true,
        done: true,
        members: { ...members, pending: 0, done: true },
        retryable: 1,
      }
      return r.fulfill({ status: 204 })
    }
    if (path === `/v1/captures/${profile}/retry-failed`) {
      const body = request.postDataJSON()
      posted.push(`retry-failed:${body.job_id ?? 'all'}`)
      const count = current.retryable ?? 0
      current = { ...current, retryable: 0 }
      return r.fulfill({ status: 202, json: { count } })
    }
    if (path === `/v1/captures/${profile}/retry`) {
      posted.push('retry')
      return r.fulfill({ json: { record_id: retried } })
    }
    if (path === '/v1/captures')
      return r.fulfill({
        json: { items: [record({ id: retried, kind: 'profile' }), current] },
      })
    if (path === `/v1/captures/${profile}`) return r.fulfill({ json: current })
    if (path === `/v1/captures/${retried}`)
      return r.fulfill({
        json: detail({ id: retried, kind: 'profile', members }),
      })
    return r.fulfill({ status: 404, json: { error: '内容不存在或已删除' } })
  })
  await page.goto(`/app/#/captures/${profile}`)
  // The toast region is a status too; this is the record's own line.
  const status = page.locator('p[role=status]')
  await expect(status).toContainText('正在保存帖子 · 帖子 2/3 · 失败 1')
  await expect(page.getByRole('progressbar')).toBeVisible()
  // Saved media are only counted; there is nothing missing to list.
  await expect(status).toContainText('帖子 2/3')
  await expect(page.getByText('已保存 2/2，失败 0')).toBeVisible()
  await expect(page.getByRole('heading', { name: /媒体/ })).toHaveCount(0)
  await expect(page.getByText('帖子不存在或已删除').first()).toBeVisible()

  // Its members predate telling new posts from updates, so all are listed
  // by default; problems remain available in their tab.
  const failed = page.getByRole('button', {
    name: /^x\.com\/fixture\/status\/2/,
  })
  await expect(failed).toContainText('失败')
  const all = page.getByRole('tab', { name: '全部 3' })
  await expect(all).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tab', { name: /^新增记录/ })).toHaveCount(0)
  await expect(page.getByText('x.com/fixture/status/3')).toBeVisible()
  await page.getByRole('tab', { name: '异常记录 1' }).click()
  await expect(page.getByText('x.com/fixture/status/3')).toHaveCount(0)
  await all.click()
  await expect(page.getByText('x.com/fixture/status/3')).toBeVisible()
  // The tab seen before shows again without loading.
  expect(memberQueries).toEqual(['', 'problem'])
  // The post still running has its own tab while it lasts.
  const running = page.getByRole('tab', { name: '进行中 1' })
  await expect(running).toBeVisible()

  // A running collection can be stopped, and only a finished one retried.
  const retryMember = page.getByRole('button', {
    name: '重试 x.com/fixture/status/2',
  })
  await expect(retryMember).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: '重新采集', exact: true }),
  ).toHaveCount(0)
  await page.getByRole('button', { name: '中止', exact: true }).click()
  await expect(status).toContainText('已中止')
  await expect(page.getByRole('progressbar')).toHaveCount(0)
  await expect(running).toHaveCount(0)

  // Failed posts are fetched again inside this record, all or one at a time;
  // one the source reported gone is not offered.
  await expect(
    page.getByRole('button', { name: '重试 x.com/fixture/status/4' }),
  ).toHaveCount(0)
  await page.getByRole('button', { name: '重试失败的帖子（1）' }).click()
  await expect(page.getByText('正在重试 1 条失败的帖子。')).toBeVisible()
  await expect(
    page.getByRole('button', { name: /重试失败的帖子/ }),
  ).toHaveCount(0)
  await retryMember.click()
  await expect(page.getByText('没有可重试的帖子。')).toBeVisible()

  await page.getByRole('button', { name: '重新采集', exact: true }).click()
  // Retrying the whole record opens the record it created.
  await expect(page).toHaveURL(new RegExp(`#/captures/${retried}$`))
  expect(posted).toEqual([
    'stop',
    'retry-failed:all',
    'retry-failed:member-failed',
    'retry',
  ])
})

test('a finished profile record fetches more pages as its own record', async ({
  page,
}) => {
  const next = '55555555-5555-4555-8555-555555555555'
  const members = {
    total: 100,
    complete: 100,
    partial: 0,
    failed: 0,
    pending: 0,
    done: true,
    added: 40,
    updated: 60,
  }
  const finished = detail({
    id: profile,
    kind: 'profile',
    url: 'https://x.com/fixture',
    state: 'complete',
    done: true,
    members,
    pages: { more: true, more_1000: true, failed: false },
  })
  const ops: string[] = []
  const memberQueries: (string | null)[] = []
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (r) => {
    const request = r.request()
    const path = new URL(request.url()).pathname
    if (path === '/v1/session') return r.fulfill({ json: {} })
    if (path === `/v1/captures/${profile}/pages`) {
      const { op } = request.postDataJSON()
      ops.push(op)
      if (op === 'more1000')
        return r.fulfill({ status: 409, json: { error: '没有更多帖子了' } })
      return r.fulfill({ status: 202, json: { id: `job-${next}` } })
    }
    if (path === `/v1/captures/${profile}/members`) {
      memberQueries.push(new URL(request.url()).searchParams.get('state'))
      return r.fulfill({ json: { items: [] } })
    }
    if (path === '/v1/captures')
      return r.fulfill({
        json: {
          items: [record({ id: next, kind: 'profile' }), finished],
        },
      })
    if (path === `/v1/captures/${profile}`) return r.fulfill({ json: finished })
    if (path === `/v1/captures/${next}`)
      return r.fulfill({
        json: detail({ id: next, kind: 'profile', members }),
      })
    return r.fulfill({ status: 404, json: { error: '内容不存在或已删除' } })
  })
  await page.goto(`/app/#/captures/${profile}`)
  await expect(page.locator('p[role=status]')).toContainText(
    '已完成 · 帖子 100/100 · 新增 40 · 更新 60',
  )
  await expect(page.getByText('新增 40，更新 60')).toBeVisible()
  // Posts are split by what this record did to the library.
  await expect(page.getByRole('tab', { name: '新增记录 40' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(page.getByRole('tab', { name: '更新记录 60' })).toBeVisible()
  // Nothing failed, so there is no tab for it.
  await expect(page.getByRole('tab', { name: /^异常记录/ })).toHaveCount(0)
  expect(memberQueries).toEqual(['added'])
  await expect(page.getByRole('button', { name: '重试本页' })).toHaveCount(0)
  await page.getByRole('button', { name: '抓取 1000 条' }).click()
  await expect(page.getByText('没有更多帖子了')).toBeVisible()
  await page.getByRole('button', { name: '抓取更多' }).click()
  await expect(page).toHaveURL(new RegExp(`#/captures/${next}$`))
  // The next page is still running, so it offers nothing to continue yet.
  await expect(page.getByRole('button', { name: '抓取更多' })).toHaveCount(0)
  expect(ops).toEqual(['more1000', 'more'])
})

test('loads more capture members automatically at the bottom', async ({
  page,
}) => {
  const cursors: string[] = []
  await page.route('**/v1/**', (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/members')) {
      const cursor = url.searchParams.get('cursor') || ''
      cursors.push(cursor)
      return route.fulfill({
        json: {
          items: Array.from({ length: cursor ? 1 : 30 }, (_, index) => ({
            job_id: `member-${cursor || 'first'}-${index}`,
            url: `https://x.com/fixture/status/${cursor ? 999 : index + 1}`,
            state: 'complete',
            saved: true,
            collection_id: collection,
            reasons: [],
          })),
          next_cursor: cursor ? '' : 'next-page',
        },
      })
    }
    return route.fulfill({
      json:
        url.pathname === `/v1/captures/${profile}`
          ? detail({
              id: profile,
              kind: 'profile',
              state: 'complete',
              done: true,
              members: {
                total: 31,
                complete: 31,
                partial: 0,
                pending: 0,
                failed: 0,
                done: true,
              },
            })
          : {},
    })
  })
  await page.goto(`/app/#/captures/${profile}`)
  await expect(page.locator('.member')).toHaveCount(30)
  await page.locator('.member').last().scrollIntoViewIfNeeded()
  await expect(page.locator('.member')).toHaveCount(31)
  expect(cursors).toEqual(['', 'next-page'])
  await expect(
    page.getByRole('button', { name: '加载更多', exact: true }),
  ).toHaveCount(0)
})

test('an update reads as one record in the list', async ({ page }) => {
  const folderUpdate = record({
    id: retried,
    job_id: '',
    collection_id: '',
    url: '',
    input: '',
    platform: '',
    kind: '',
    members: {
      total: 14,
      complete: 9,
      partial: 0,
      failed: 1,
      pending: 2,
      done: false,
      added: 3,
      updated: 6,
    },
    update: {
      target: 'folder',
      target_id: collection,
      name: '猫',
      posts: 10,
      profiles: 2,
      options: { posts: 'latest', relations: false },
      queued: 2,
      skipped: 0,
    },
  })
  const selection = record({
    id: profile,
    url: '',
    state: 'complete',
    done: true,
    members: {
      total: 3,
      complete: 3,
      partial: 0,
      failed: 0,
      pending: 0,
      done: true,
      added: 0,
      updated: 3,
    },
    update: {
      target: 'many',
      posts: 3,
      profiles: 0,
      options: { posts: 'latest', relations: false },
      queued: 0,
      skipped: 0,
    },
  })
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (r) => {
    const path = new URL(r.request().url()).pathname
    if (path === '/v1/session') return r.fulfill({ json: {} })
    if (path === '/v1/captures')
      return r.fulfill({ json: { items: [folderUpdate, selection] } })
    return r.fulfill({ status: 404, json: { error: '内容不存在或已删除' } })
  })
  await page.goto('/app/#/captures')
  const running = page.getByRole('link', { name: /更新收藏夹「猫」/ })
  await expect(running).toContainText('正在更新')
  await expect(running).toContainText('新增 3 · 更新 6 · 异常 1 · 进行中 4')
  await expect(running.getByRole('progressbar')).toHaveAttribute(
    'value',
    String(10 / 14),
  )
  const done = page.getByRole('link', { name: /更新 3 项/ })
  await expect(done).toContainText('已完成')
  await expect(done).toContainText('更新 3')
})

test("an update's profile stopped by the post cap reads on in the same record", async ({
  page,
}) => {
  let continued = false
  const members = (pending: number) => ({
    total: 1001 + pending,
    complete: 1001,
    partial: 0,
    failed: 0,
    pending,
    done: pending === 0,
    added: 1000,
    updated: 1,
  })
  const update = () =>
    detail({
      id: retried,
      job_id: '',
      collection_id: profile,
      url: 'https://x.com/cat',
      kind: 'profile',
      state: continued ? 'queued' : 'complete',
      done: !continued,
      members: members(continued ? 100 : 0),
      update: {
        target: 'collection',
        target_id: profile,
        handle: 'cat',
        posts: 0,
        profiles: 1,
        options: { posts: 'until_existing', relations: false },
        queued: 0,
        skipped: 0,
      },
      profiles: [
        {
          collection_id: profile,
          url: 'https://x.com/cat',
          handle: 'cat',
          state: 'complete',
          posts: continued
            ? {
                total: 1100,
                finished: 1000,
                pending: 100,
                done: false,
                capped: false,
              }
            : {
                total: 1000,
                finished: 1000,
                pending: 0,
                done: true,
                capped: true,
              },
        },
      ],
    })
  const sent: unknown[] = []
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (r) => {
    const request = r.request()
    const path = new URL(request.url()).pathname
    if (path === '/v1/session') return r.fulfill({ json: {} })
    if (path === `/v1/updates/${retried}/continue`) {
      sent.push(request.postDataJSON())
      continued = true
      return r.fulfill({ status: 204 })
    }
    if (path === `/v1/captures/${retried}/members`)
      return r.fulfill({ json: { items: [] } })
    if (path === `/v1/captures/${retried}`) return r.fulfill({ json: update() })
    return r.fulfill({ status: 404, json: { error: '内容不存在或已删除' } })
  })
  await page.goto(`/app/#/captures/${retried}`)
  const profiles = page.locator('.section').filter({
    has: page.getByRole('heading', { name: '账号' }),
  })
  await expect(profiles).toContainText('资料 ✓ · 帖子 1000（未到已有数据）')
  await profiles.getByRole('button', { name: '继续抓取' }).click()
  // The same record, now reading on.
  await expect(profiles).toContainText('资料 ✓ · 帖子 1000/1100')
  await expect(page).toHaveURL(new RegExp(`#/captures/${retried}$`))
  await expect(profiles.getByRole('button', { name: '继续抓取' })).toHaveCount(
    0,
  )
  expect(sent).toEqual([{ collection_id: profile }])
})
