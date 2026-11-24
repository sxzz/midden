import { expect, test } from '@playwright/test'

const profileId = '77777777-7777-4777-8777-777777777777'
const friendId = '66666666-6666-4666-8666-666666666666'
const profile = {
  id: profileId,
  url: 'https://x.com/i/user/100',
  observed_at: '2026-11-05T08:00:00Z',
  saved_at: '2026-11-01T08:00:00Z',
  revision_id: 'revision-1',
  author_name: '中心账号',
  text: '',
  assets: [],
  graph: {
    root: 'profile',
    relations: [],
    entities: [
      {
        key: 'profile',
        type: 'x.profile',
        external_id: '100',
        data: { name: '中心账号', username: 'center', metadata: {} },
      },
    ],
  },
}
const node = (i: number) => ({
  entity_id: `e${i}`,
  external_id: String(i),
  name: `账号 ${i}`,
  followers: 1000 - i,
  kind: i % 3 === 0 ? 'mutual' : i % 3 === 1 ? 'following' : 'followers',
  ...(i === 1 ? { collection_id: friendId } : {}),
})
const graph = (limit: number) => ({
  nodes: [
    {
      entity_id: 'c',
      external_id: '100',
      name: '中心账号',
      collection_id: profileId,
    },
    ...Array.from({ length: Math.min(limit, 450) }, (_, i) => node(i + 1)),
  ],
  edges: [[0, 1]],
  total: 450,
  kinds: { following: 150, followers: 150, mutual: 150 },
  lists: {
    following: { complete_at: '2026-11-20T08:00:00Z' },
    followers: {},
  },
})

test('opens a profile’s follow graph, with kinds to choose and more to load', async ({
  page,
}) => {
  await page.route('https://telegram.org/**', (route) =>
    route.fulfill({ body: '' }),
  )
  const asked: string[] = []
  const fixed: Record<string, unknown> = {
    '/v1/collections': { items: [] },
    '/v1/tags': [],
    [`/v1/collections/${profileId}`]: profile,
    [`/v1/collections/${profileId}/follows`]: {
      following: 300,
      followers: 300,
      mutual: 150,
    },
    [`/v1/collections/${profileId}/follow-changes`]: { items: [] },
    [`/v1/collections/${profileId}/profile-changes`]: { items: [] },
    [`/v1/collections/${profileId}/counts`]: { points: [] },
    [`/v1/collections/${profileId}/history`]: { items: [] },
    [`/v1/collections/${profileId}/annotation`]: { note: '', tags: [] },
  }
  await page.route('**/v1/**', (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/graph')) {
      asked.push(url.search)
      return route.fulfill({
        json: graph(Number(url.searchParams.get('limit'))),
      })
    }
    return route.fulfill({ json: fixed[url.pathname] ?? {} })
  })
  await page.goto(`/app/#/collection/${profileId}`)

  await page.getByRole('button', { name: '关系图谱' }).click()
  await expect(page).toHaveURL(new RegExp(`/collection/${profileId}/graph$`))
  await expect(page.locator('h1')).toHaveText('关系图谱')
  const chips = page
    .getByRole('group', { name: '显示的账号' })
    .getByRole('button')
  await expect(chips).toHaveText([
    /^关注\s*150$/,
    /^粉丝\s*150$/,
    /^互关\s*150$/,
  ])
  for (const chip of await chips.all())
    await expect(chip).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.lists')).toHaveText(
    /^关注名单 11-2\d 完整抓取 · 粉丝名单未抓取$/,
  )
  expect(asked).toEqual(['?limit=300'])

  const more = page.getByRole('button', { name: /^显示更多/ })
  await expect(more).toHaveText(/300 \/ 450/)
  await more.click()
  await expect.poll(() => asked.at(-1)).toBe('?limit=600')
  await expect(more).toBeHidden()

  await chips.nth(1).click()
  await expect(chips.nth(1)).toHaveAttribute('aria-pressed', 'false')
  await expect
    .poll(() => asked.at(-1))
    .toBe(`?kinds=${encodeURIComponent('following,mutual')}&limit=300`)

  await page.getByRole('button', { name: '返回', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/collection/${profileId}$`))
})
