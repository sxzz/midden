import { expect, test } from './test'

const profileId = '66666666-6666-4666-8666-666666666666'
const profile = {
  id: profileId,
  url: 'https://example.test/owner',
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
        data: {
          username: 'owner',
          metadata: { followers: 1300, following: 20, statuses: 41 },
        },
      },
    ],
  },
}
const reading = (day: number, followers: number, statuses: number) => ({
  capture_id: `capture-${day}`,
  observed_at: `2026-11-0${day}T08:00:00Z`,
  counts: {
    '/metadata/followers': followers,
    '/metadata/following': 20,
    '/metadata/statuses': statuses,
  },
})
const readings = [
  reading(1, 1000, 30),
  reading(2, 1100, 33),
  reading(3, 1250, 36),
  reading(5, 1300, 41),
]

test('charts a profile’s counts from its detail and returns to it', async ({
  page,
}) => {
  await page.route('https://telegram.org/**', (route) =>
    route.fulfill({ body: '' }),
  )
  await page.route('**/v1/**', (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    let json: unknown = {}
    if (path === '/v1/collections') json = { items: [] }
    else if (path.endsWith('/counts')) {
      const limit = Number(url.searchParams.get('limit') || readings.length)
      json = { entity_type: 'x.profile', points: readings.slice(-limit) }
    } else if (path.endsWith('/history')) json = { items: [] }
    else if (path.endsWith('/availability')) json = { available: true }
    else if (path.endsWith('/annotation')) json = { note: '', tags: [] }
    else if (path === '/v1/tags') json = []
    else if (path === `/v1/collections/${profileId}`) json = profile
    return route.fulfill({ json })
  })
  await page.goto(`/app/#/collection/${profileId}`)
  await page.getByRole('button', { name: '统计趋势' }).click()
  await expect(page).toHaveURL(new RegExp(`/collection/${profileId}/stats$`))
  await expect(page.locator('h1')).toHaveText('统计趋势')
  await expect(page.locator('.summary')).toHaveText(
    '4 次抓取 · 11月1日 – 11月5日',
  )
  const charts = page.locator('.trend')
  await expect(charts.locator('.label')).toHaveText([
    '关注者',
    '正在关注',
    '帖子',
  ])
  const followers = charts.first()
  await expect(followers.locator('.value')).toHaveText('1,300')
  await expect(followers.locator('.meta')).toHaveText('期间 +300')

  // A finger dragged along a chart reads each capture on every chart.
  const box = (await followers.locator('.plot').boundingBox())!
  const y = box.y + box.height / 2
  const client = await page.context().newCDPSession(page)
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: box.x + 2, y }],
  })
  await expect(followers.locator('.value')).toHaveText('1,000')
  await expect(charts.nth(2).locator('.value')).toHaveText('30')
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: box.x + box.width * 0.3, y }],
  })
  await expect(followers.locator('.value')).toHaveText('1,100')
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  })
  await client.detach()
  // The reading stays after the finger lifts, until a tap elsewhere.
  await expect(followers.locator('.value')).toHaveText('1,100')
  await page.locator('.summary').click()
  await expect(followers.locator('.value')).toHaveText('1,300')

  await page.getByRole('button', { name: '返回', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/collection/${profileId}$`))
  await expect(page.locator('h1')).toHaveText('收藏详情')
})
