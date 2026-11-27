import { expect, test } from './test'

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
  await page.goto(`/collection/${profileId}`)

  await page.getByRole('link', { name: '关系图谱' }).click()
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

  // The same accounts as a list, by kind, most followed first.
  const modes = page
    .getByRole('group', { name: '显示方式' })
    .getByRole('button')
  await expect(modes).toHaveText(['图谱', '列表'])
  await modes.nth(1).click()
  await expect(modes.nth(1)).toHaveAttribute('aria-pressed', 'true')
  const sections = page.locator('.list section')
  // The mock answers every kind, 100 of each among the first 300.
  await expect(sections.locator('h2')).toHaveText([
    /^互关\s*100$/,
    /^关注\s*100$/,
    /^粉丝\s*100$/,
  ])
  await expect(sections.first().locator('.name').first()).toHaveText('账号 3')
  await sections.nth(1).locator('.person').first().click()
  const card = page.getByRole('region', { name: '账号' })
  await expect(card.locator('.name')).toHaveText('账号 1')
  await expect(card.locator('.actions a')).toHaveText([
    '以他为中心',
    '打开详情',
  ])
  await card.getByRole('link', { name: '以他为中心' }).click()
  await expect(page).toHaveURL(new RegExp(`/collection/${friendId}/graph$`))
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`/collection/${profileId}/graph$`))

  await page.getByRole('link', { name: '返回', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/collection/${profileId}$`))
})

test('marks the graph by a viewer account, and starts a comparison from it', async ({
  page,
}) => {
  await page.route('https://telegram.org/**', (route) =>
    route.fulfill({ body: '' }),
  )
  const OWN = 'x/x.profile/9'
  const OTHER = 'x/x.profile/8'
  const perspectives = [
    { id: OWN, name: '我', username: 'me', own: true },
    { id: OTHER, name: '别人', username: 'other' },
    { id: 'x/x.profile/100', name: '中心账号', username: 'center' },
  ].map((p) => ({ ...p, following: {}, followers: {} }))
  const asked: URLSearchParams[] = []
  await page.route('**/v1/**', (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/graph')) {
      asked.push(url.searchParams)
      const viewer = url.searchParams.get('viewer')
      const base = graph(300)
      return route.fulfill({
        json: {
          ...base,
          nodes: base.nodes.map((node, i) => ({
            ...node,
            key: `x/x.profile/${node.external_id}`,
            ...(viewer && i % 4 === 1
              ? { viewer: i % 8 === 1 ? 'mutual' : 'following' }
              : viewer && i % 9 === 2
                ? { viewer: 'follower' }
                : {}),
          })),
          ...(viewer
            ? {
                viewer: {
                  key: viewer,
                  name: viewer === OWN ? '我' : '别人',
                  username: viewer === OWN ? 'me' : 'other',
                  lists: {
                    following: { complete_at: '2026-11-21T08:00:00Z' },
                    followers: {},
                  },
                },
              }
            : {}),
        },
      })
    }
    if (url.pathname === '/v1/collections/perspectives') {
      const keys = url.searchParams.getAll('rel_of')
      return route.fulfill({
        json: {
          items: keys.length
            ? perspectives.filter((p) => keys.includes(p.id))
            : perspectives,
        },
      })
    }
    if (url.pathname === '/v1/collections/compare')
      return route.fulfill({
        json: { accounts: [], items: [], total: 0, edges: [], combos: [] },
      })
    return route.fulfill({ json: url.pathname === '/v1/tags' ? [] : {} })
  })
  await page.goto(`/collection/${profileId}/graph`)
  // The owner's own account marks the graph by default.
  await expect.poll(() => asked.at(-1)?.get('viewer')).toBe(OWN)
  expect(asked).toHaveLength(1)
  const chip = page.locator('.viewer-bar .chip')
  await expect(chip).toHaveText(/^与 @me 的关系\s*\d+$/)
  await expect(page.locator('.viewer-bar .lists')).toHaveText(
    /^@me 关注名单 11-21 完整抓取 · 粉丝名单未抓取$/,
  )
  await chip.click()
  await expect(chip).toHaveAttribute('aria-pressed', 'true')
  const modes = page
    .getByRole('group', { name: '显示方式' })
    .getByRole('button')
  await modes.nth(1).click()
  await expect(page.locator('.list .viewer-mark').first()).toBeVisible()
  await expect(page.locator('.list .avatar.faded').first()).toBeVisible()
  await page.screenshot({ path: 'test-results/graph-viewer-list.png' })
  await page.locator('.list .viewer-mark').first().click()
  await expect(
    page.getByRole('region', { name: '账号' }).locator('.viewer'),
  ).toHaveText(/^(与 @me 互关|@me 关注了 TA|TA 关注了 @me)$/)
  await page.getByRole('button', { name: '关闭' }).click()
  await modes.nth(0).click()
  await page.waitForTimeout(500)
  await page.screenshot({ path: 'test-results/graph-viewer.png' })

  // Another viewer, kept in the address.
  await page.locator('.viewer-bar summary').click()
  await page
    .locator('.viewer-bar [role=option]')
    .filter({ hasText: '@other' })
    .click()
  await expect.poll(() => asked.at(-1)?.get('viewer')).toBe(OTHER)
  await expect(page).toHaveURL(/viewer=x(%2F|\/)x\.profile(%2F|\/)8/)
  await expect(chip).toHaveText(/^与 @other 的关系/)

  // 对比: the profile and the accounts picked.
  await page.getByRole('button', { name: '对比', exact: true }).click()
  await page.locator('.compare summary').click()
  const options = page.locator('.compare [role=option]')
  // The profile itself is not offered.
  await expect(options).toHaveText(['我 @me', '别人 @other'])
  await options.filter({ hasText: '@me' }).click()
  await page.getByRole('link', { name: '对比 2 个账号' }).click()
  await expect(page).toHaveURL(/\/compare\?/)
  const address = new URLSearchParams(page.url().split('?', 2)[1])
  expect(address.getAll('rel_of')).toEqual(['x/x.profile/100', OWN])
  expect(address.get('viewer')).toBe(OTHER)
  await expect(page.locator('h1')).toHaveText('关系对比')
})
