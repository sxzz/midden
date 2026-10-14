import { expect, test } from '@playwright/test'

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
  update_mode: 'full',
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
    if (path === '/v1/session') return r.fulfill({ json: { tenant_id: 'x' } })
    if (path === '/v1/collections') {
      listReloads++
      return r.fulfill({ json: { items: [] } })
    }
    if (path === '/v1/captures' && request.method() === 'POST') {
      const body = request.postDataJSON()
      submitted.push(body)
      if (body.url.includes('unsupported.test'))
        return r.fulfill({ status: 400, json: { error: 'unsupported URL' } })
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
          warnings: ['resource omitted: unsupported type or resource limit'],
          media_items: [
            { position: 0, kind: 'image', state: 'ready' },
            {
              position: 1,
              kind: 'video',
              state: 'failed',
              error: 'context deadline exceeded',
            },
          ],
        }),
      })
    return r.fulfill({ status: 404, json: { error: 'not found' } })
  })
  await page.goto('/app/')
  await page.getByRole('link', { name: '采集', exact: true }).click()
  await expect(page.locator('h1')).toHaveText('采集')
  await expect(page.getByText('暂无采集记录')).toBeVisible()
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
    '已提交 1 条，1 条未提交：不支持的链接。',
  )
  expect(submitted).toEqual([
    { url: 'https://fxtwitter.com/fixture/status/1' },
    { url: 'https://unsupported.test/a' },
  ])
  // The link that failed stays to be corrected.
  await expect(page.getByLabel('链接')).toHaveValue(
    'https://unsupported.test/a',
  )

  const row = page.getByRole('button', { name: /x\.com\/fixture\/status\/1/ })
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
    reasons: [{ reason: 'post not found or deleted', count: 1 }],
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
    if (path === '/v1/session') return r.fulfill({ json: { tenant_id: 'x' } })
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
        error: 'post not found or deleted',
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
      return r.fulfill({
        json: { items: state ? [failed] : [failed, complete] },
      })
    }
    if (path === `/v1/captures/${profile}/stop`) {
      posted.push('stop')
      current = {
        ...current,
        stopped: true,
        done: true,
        members: { ...members, pending: 0, done: true },
      }
      return r.fulfill({ status: 204 })
    }
    if (path === `/v1/captures/${profile}/retry`) {
      posted.push('retry')
      return r.fulfill({ status: 202, json: { id: `job-${retried}` } })
    }
    if (path === '/v1/captures' && request.method() === 'POST') {
      posted.push(request.postDataJSON().url)
      return r.fulfill({ status: 202, json: { id: 'member-again' } })
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
    return r.fulfill({ status: 404, json: { error: 'not found' } })
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

  // Members needing attention come first; the rest are one tab away.
  const failed = page.getByRole('button', {
    name: /^x\.com\/fixture\/status\/2/,
  })
  await expect(failed).toContainText('失败')
  await expect(page.getByText('x.com/fixture/status/3')).toHaveCount(0)
  await page.getByRole('tab', { name: '全部帖子' }).click()
  await expect(page.getByText('x.com/fixture/status/3')).toBeVisible()
  expect(memberQueries.at(-1)).toBe('')
  expect(memberQueries[0]).toBe('problem')

  await page
    .getByRole('button', { name: '重试 x.com/fixture/status/2' })
    .click()
  await expect.poll(() => posted).toEqual(['https://x.com/fixture/status/2'])

  // A running collection can be stopped, and only a finished one retried.
  await expect(
    page.getByRole('button', { name: '重新采集', exact: true }),
  ).toHaveCount(0)
  await page.getByRole('button', { name: '中止', exact: true }).click()
  await expect(status).toContainText('已中止')
  await expect(page.getByRole('progressbar')).toHaveCount(0)
  await page.getByRole('button', { name: '重新采集', exact: true }).click()
  // Retrying opens the record it created.
  await expect(page).toHaveURL(new RegExp(`#/captures/${retried}$`))
  expect(posted).toEqual(['https://x.com/fixture/status/2', 'stop', 'retry'])
})
