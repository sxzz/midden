import { expect, test, type Page } from './test'

const A = 'x/x.profile/1'
const B = 'x/x.profile/2'
const C = 'x/x.profile/3'
const OWN = 'x/x.profile/9'
const centers = [
  { key: A, name: '甲', username: 'alpha' },
  { key: B, name: '乙', username: 'beta' },
  { key: C, name: '丙', username: 'gamma' },
]
const perspectives = [
  { id: OWN, name: '我', username: 'me', own: true },
  ...centers.map((c) => ({ id: c.key, name: c.name, username: c.username })),
].map((p) => ({ ...p, following: {}, followers: {} }))

/** Which of the three each found account relates to, by its number. */
const subsets = [[0, 1, 2], [0, 1], [1, 2], [0, 2], [0], [1], [2]]
const accounts = Array.from({ length: 90 }, (_, i) => ({
  entity_id: `e${i}`,
  key: `x/x.profile/${100 + i}`,
  external_id: String(100 + i),
  name: `账号 ${i}`,
  followers: 5000 - i * 37,
  of: subsets[i % subsets.length]!,
  ...(i % 5 === 0
    ? { viewer: 'mutual' }
    : i % 7 === 0
      ? { viewer: 'following' }
      : {}),
}))

function compare(url: URL) {
  const keys = url.searchParams.getAll('rel_of')
  const n = keys.length
  const min = Number(url.searchParams.get('rel_min') ?? Math.min(2, n))
  const only = url.searchParams.get('only')
  const qualifying = accounts
    .map((a) => ({ ...a, of: a.of.filter((i) => i < n) }))
    .filter((a) => a.of.length && a.of.length >= min)
  const combos = new Map<string, number>()
  for (const a of qualifying)
    combos.set(a.of.join(','), (combos.get(a.of.join(',')) ?? 0) + 1)
  const chosen = only
    ? qualifying.filter((a) => a.of.join(',') === only)
    : qualifying
  const limit = Number(url.searchParams.get('limit') ?? 300)
  const items = chosen.slice(0, limit)
  const viewer = url.searchParams.get('viewer')
  return {
    accounts: keys.map((key) => {
      const c = centers.find((center) => center.key === key)!
      return {
        entity_id: `c-${key}`,
        key,
        external_id: key.split('/', 3)[2],
        name: c.name,
        username: c.username,
        followers: 1000,
        lists: {
          following: { complete_at: '2026-11-20T08:00:00.000Z' },
          followers: {},
        },
      }
    }),
    items: items.map((item) =>
      viewer ? item : { ...item, viewer: undefined },
    ),
    total: chosen.length,
    // 甲 follows 乙, 乙 and 丙 follow each other; and a few among the found.
    edges: [
      [0, 1],
      [1, 2],
      [2, 1],
      ...items.slice(0, 20).map((_item, i) => [n + i, n + ((i + 3) % 20)]),
    ].filter(([a, b]) => a! < n + items.length && b! < n + items.length),
    combos: [...combos]
      .map(([of, count]) => ({ of: of.split(',').map(Number), count }))
      .toSorted((a, b) => b.count - a.count || b.of.length - a.of.length),
    ...(viewer
      ? {
          viewer: {
            key: viewer,
            name: '我',
            username: 'me',
            lists: {
              following: { complete_at: '2026-11-21T08:00:00.000Z' },
              followers: { complete_at: '2026-11-21T08:00:00.000Z' },
            },
          },
        }
      : {}),
  }
}

async function mock(page: Page) {
  const asked: URLSearchParams[] = []
  const listed: URLSearchParams[] = []
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/v1/collections/compare') {
      asked.push(url.searchParams)
      return route.fulfill({ json: compare(url) })
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
    if (url.pathname === '/v1/tags' || url.pathname === '/v1/folders')
      return route.fulfill({ json: [] })
    if (url.pathname === '/v1/collections') listed.push(url.searchParams)
    return route.fulfill({ json: { items: [] } })
  })
  return { asked, listed }
}

test('compares accounts: who follows whom, shared accounts by subset, the threshold', async ({
  page,
}) => {
  const { asked, listed } = await mock(page)
  await page.goto(`/app/#/compare?rel_of=${A}&rel_of=${B}&rel_of=${C}`)
  await expect(page.locator('h1')).toHaveText('关系对比')
  const last = () => asked.at(-1)
  // The owner's own account marks the accounts by default.
  await expect
    .poll(() => [
      last()?.getAll('rel_of'),
      last()?.get('rel'),
      last()?.get('viewer'),
    ])
    .toEqual([[A, B, C], 'following', OWN])
  await expect(page.locator('.center .name')).toHaveText(['甲', '乙', '丙'])
  // 甲 follows 乙; 乙 and 丙 each other.
  const cells = page.locator('.matrix tbody tr')
  await expect(cells.nth(0).locator('td')).toHaveText(['', '✓', ''])
  await expect(cells.nth(1).locator('td')).toHaveText(['', '', '✓'])
  await expect(cells.nth(2).locator('td')).toHaveText(['', '✓', ''])
  // Two in common by default: four subsets, the largest first.
  const rows = page.locator('.combos .row')
  await expect(rows).toHaveCount(4)
  await expect(page.locator('.total')).toContainText('52 个账号')
  await expect(page.locator('.grid .person')).toHaveCount(52)
  await expect(page.locator('.notes li')).toHaveText([
    /^@alpha 关注 11-2\d 完整$/,
    /^@beta 关注 11-2\d 完整$/,
    /^@gamma 关注 11-2\d 完整$/,
  ])
  // The viewer's marks, and a chip to fade the rest.
  const chip = page.locator('.viewer-bar .chip')
  await expect(chip).toHaveText(/与 @me 的关系/)
  await expect(page.locator('.grid .viewer-mark').first()).toBeVisible()
  await chip.click()
  await expect(chip).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.grid .avatar.faded').first()).toBeVisible()
  await chip.click()

  // A row shows its subset alone.
  await rows.nth(1).click()
  await expect.poll(() => last()?.get('only')).toMatch(/^\d(,\d)+$/)
  await expect(rows.nth(1)).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.total')).toContainText('13 个账号')
  await expect(page).toHaveURL(/only=/)
  await page.locator('.only').click()
  await expect.poll(() => last()?.get('only')).toBeNull()

  // All three.
  await page
    .getByRole('group', { name: '至少几人' })
    .getByRole('button', { name: '增加' })
    .click()
  await expect.poll(() => last()?.get('rel_min')).toBe('3')
  await expect(rows).toHaveCount(1)
  await expect(page.locator('.grid .person')).toHaveCount(13)

  // A tapped account says which of them it relates to.
  await page.locator('.grid .person').first().click()
  const card = page.getByRole('region', { name: '账号' })
  await expect(card.locator('.why')).toHaveText('甲、乙、丙 关注了 TA')
  await expect(card.locator('.viewer')).toHaveText('与 @me 互关')
  await card.getByRole('button', { name: '关闭' }).click()

  // Followers instead.
  await page
    .getByRole('group', { name: '对比方向' })
    .getByRole('button', { name: '粉丝' })
    .click()
  await expect.poll(() => last()?.get('rel')).toBe('followers')

  // The graph: the compared accounts spread apart.
  await page
    .getByRole('group', { name: '显示方式' })
    .getByRole('button', { name: '图谱' })
    .click()
  await expect(page).toHaveURL(/view=graph/)
  await expect(page.locator('.surface canvas').first()).toBeVisible()

  // The library with the same filter, ready to save as a folder.
  await page.getByRole('link', { name: '在收藏库中查看' }).click()
  await expect
    .poll(() => {
      const q = listed.at(-1)
      return q && [q.getAll('rel_of'), q.get('rel'), q.get('rel_min')]
    })
    .toEqual([[A, B, C], 'followers', '3'])
  await expect(page.locator('.filter-summary')).toHaveText(
    '关注 @alpha、@beta、@gamma 中至少 3 人的',
  )
})

test('adds and removes compared accounts', async ({ page }) => {
  const { asked } = await mock(page)
  await page.goto(`/app/#/compare?rel_of=${A}&viewer=`)
  await expect(page.locator('.center')).toHaveCount(1)
  // Nobody to mark with: no viewer in the request.
  await expect.poll(() => asked.at(-1)?.has('viewer')).toBe(false)
  await page.locator('.add summary').click()
  const options = page.locator('.add [role=option]')
  await expect(options).toHaveText(['我 @me', '乙 @beta', '丙 @gamma'])
  await options.filter({ hasText: '@beta' }).click()
  await expect.poll(() => asked.at(-1)?.getAll('rel_of')).toEqual([A, B])
  await expect(page.locator('.center')).toHaveCount(2)
  await page.getByRole('button', { name: '移除 甲' }).click()
  await expect.poll(() => asked.at(-1)?.getAll('rel_of')).toEqual([B])
})

for (const [name, viewport] of [
  ['phone', { width: 390, height: 844 }],
  ['desktop', { width: 1280, height: 860 }],
] as const)
  for (const scheme of ['light', 'dark'] as const)
    test(`looks right: ${name}, ${scheme}`, async ({ page }) => {
      await page.setViewportSize(viewport)
      await page.emulateMedia({ colorScheme: scheme })
      await mock(page)
      await page.goto(
        `/app/#/compare?rel_of=${A}&rel_of=${B}&rel_of=${C}&rel_min=1`,
      )
      await expect(page.locator('.grid .person').first()).toBeVisible()
      await page.screenshot({
        path: `test-results/compare-${name}-${scheme}.png`,
        fullPage: true,
      })
      await page
        .getByRole('group', { name: '显示方式' })
        .getByRole('button', { name: '图谱' })
        .click()
      await expect(page.locator('.surface canvas').first()).toBeVisible()
      await page.locator('.stage').scrollIntoViewIfNeeded()
      await page.waitForTimeout(600)
      await page.locator('.stage').screenshot({
        path: `test-results/compare-graph-${name}-${scheme}.png`,
      })
    })
