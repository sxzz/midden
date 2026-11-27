import { expect, test, type Locator, type Page } from './test'

// Every internal destination is a real link: Cmd/Ctrl-click or the middle
// button opens it in a new tab and leaves this page as it was.

const profileId = '77777777-7777-4777-8777-777777777777'
const friendId = '66666666-6666-4666-8666-666666666666'
const postId = '55555555-5555-4555-8555-555555555555'
const recordId = '44444444-4444-4444-8444-444444444444'
const folderId = '00000000-0000-7000-8000-00000000000f'
const KEY = 'x/x.profile/100'
const FRIEND = 'x/x.profile/1'

const author = {
  key: 'profile',
  type: 'x.profile',
  external_id: '100',
  saved_collection_id: profileId,
  data: { name: '中心账号', username: 'center' },
}
const profile = {
  id: profileId,
  url: 'https://x.com/center',
  observed_at: '2026-11-05T08:00:00Z',
  saved_at: '2026-11-01T08:00:00Z',
  revision_id: 'r1',
  author_name: '中心账号',
  text: '',
  assets: [],
  graph: { root: 'profile', relations: [], entities: [author] },
}
const post = {
  id: postId,
  url: 'https://x.com/center/status/1',
  observed_at: '2026-11-05T08:00:00Z',
  saved_at: '2026-11-05T08:00:00Z',
  revision_id: 'r2',
  author_name: '中心账号',
  text: '一条帖子',
  assets: [],
  graph: {
    root: 'post',
    entities: [
      { key: 'post', type: 'x.post', external_id: '1', data: {} },
      author,
    ],
    relations: [{ source: 'post', target: 'profile', type: 'authored_by' }],
  },
}
const graph = {
  nodes: [
    {
      entity_id: 'c',
      key: KEY,
      external_id: '100',
      name: '中心账号',
      username: 'center',
      collection_id: profileId,
    },
    {
      entity_id: 'f',
      key: FRIEND,
      external_id: '1',
      name: '朋友',
      username: 'friend',
      followers: 10,
      kind: 'mutual',
      collection_id: friendId,
    },
  ],
  edges: [[0, 1]],
  total: 1,
  kinds: { following: 0, followers: 0, mutual: 1 },
  lists: { following: {}, followers: {} },
}
const compare = {
  accounts: [KEY, FRIEND].map((key, i) => ({
    entity_id: `c${i}`,
    key,
    external_id: key.split('/', 3)[2],
    name: i ? '朋友' : '中心账号',
    username: i ? 'friend' : 'center',
    collection_id: i ? friendId : profileId,
    lists: { following: {}, followers: {} },
  })),
  items: [
    {
      entity_id: 'x',
      key: 'x/x.profile/5',
      external_id: '5',
      name: '共同关注',
      username: 'shared',
      collection_id: postId,
      of: [0, 1],
    },
  ],
  total: 1,
  edges: [],
  combos: [{ of: [0, 1], count: 1 }],
}
const record = {
  id: recordId,
  job_id: 'job',
  collection_id: postId,
  saved: true,
  url: 'https://x.com/center/status/1',
  input: 'https://x.com/center/status/1',
  platform: 'x',
  kind: 'post',
  state: 'succeeded',
  media: { total: 0, ready: 0, failed: 0 },
  created_at: '2026-11-05T08:00:00Z',
  done: true,
}
const folder = {
  id: folderId,
  name: '帖子夹',
  filter: '',
  count: 1,
  types: { 'x.post': 1 },
  created_at: '2026-11-01T00:00:00.000Z',
  updated_at: '2026-11-01T00:00:00.000Z',
}

/** The API for this page and every tab it opens. */
async function mock(page: Page) {
  const context = page.context()
  await context.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await context.route('**/v1/**', (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    const fixed: Record<string, unknown> = {
      '/v1/session': {},
      '/v1/tags': [],
      '/v1/folders': [folder],
      '/v1/collections': { items: [post] },
      '/v1/collections/count': { count: 1, types: { 'x.post': 1 } },
      '/v1/collections/compare': compare,
      '/v1/collections/perspectives': { items: [] },
      '/v1/captures': { items: [record] },
      [`/v1/captures/${recordId}`]: {
        ...record,
        warnings: [],
        media_items: [],
        reasons: [],
      },
      [`/v1/collections/${profileId}`]: profile,
      [`/v1/collections/${postId}`]: post,
      [`/v1/collections/${friendId}`]: profile,
      [`/v1/collections/${profileId}/follows`]: {
        following: 3,
        followers: 4,
        mutual: 1,
      },
      [`/v1/collections/${profileId}/graph`]: graph,
    }
    let json = fixed[path]
    if (json === undefined) {
      if (path.endsWith('/counts'))
        json = {
          entity_type: 'x.profile',
          points: [1, 2].map((day) => ({
            capture_id: `c${day}`,
            observed_at: `2026-11-0${day}T08:00:00Z`,
            counts: { '/metadata/followers': day * 100 },
          })),
        }
      else if (path.endsWith('/availability')) json = { available: true }
      else if (path.endsWith('/annotation')) json = { note: '', tags: [] }
      else if (path === '/v1/shares') json = []
      else json = { items: [] }
    }
    return route.fulfill({ json })
  })
}

/**
 * Open `link` with a modified click (or the middle button): a new tab at
 * `url`, and this page where it was.
 */
async function opensInNewTab(
  page: Page,
  link: Locator,
  url: RegExp,
  how: 'modifier' | 'middle' = 'modifier',
) {
  const before = page.url()
  const opened = page.context().waitForEvent('page')
  await (how === 'middle'
    ? link.click({ button: 'middle' })
    : link.click({ modifiers: ['ControlOrMeta'] }))
  const tab = await opened
  await expect(tab).toHaveURL(url)
  await tab.close()
  expect(page.url()).toBe(before)
}

test('library items, folders and records open in a new tab', async ({
  page,
}) => {
  await mock(page)
  await page.goto('/')
  const row = page.locator('.row', { hasText: '一条帖子' })
  await opensInNewTab(page, row.locator('.head'), /\/collection\/5{8}-/)
  await opensInNewTab(
    page,
    row.locator('.head'),
    new RegExp(`/collection/${postId}$`),
    'middle',
  )
  // The row's whole surface is the link.
  await expect(row.locator('.head')).toHaveAttribute(
    'href',
    `/collection/${postId}`,
  )
  await opensInNewTab(
    page,
    page.getByRole('navigation', { name: '收藏夹' }).getByRole('link'),
    new RegExp(String.raw`/folder/${folderId}\?`),
  )
  await opensInNewTab(
    page,
    page.getByRole('link', { name: '采集', exact: true }),
    /\/captures$/,
  )

  await page.goto('/captures')
  await opensInNewTab(
    page,
    page.locator('a.record'),
    new RegExp(`/captures/${recordId}$`),
  )
  // A plain click still navigates here.
  await page.locator('a.record').click()
  await expect(page).toHaveURL(new RegExp(`/captures/${recordId}$`))
  await opensInNewTab(
    page,
    page.getByRole('link', { name: '查看收藏' }),
    new RegExp(`/collection/${postId}$`),
  )
})

test('the detail page opens its pages and relation counts in a new tab', async ({
  page,
}) => {
  await mock(page)
  await page.goto(`/collection/${profileId}`)
  await opensInNewTab(
    page,
    page.getByRole('link', { name: '统计趋势' }),
    new RegExp(`/collection/${profileId}/stats$`),
  )
  await opensInNewTab(
    page,
    page.getByRole('link', { name: '关系图谱' }),
    new RegExp(`/collection/${profileId}/graph$`),
  )
  await opensInNewTab(
    page,
    page.getByRole('link', { name: /^粉丝 4，在收藏库中查看/ }),
    /\/\?.*rel=followers/,
  )
  await page.getByRole('link', { name: '关系图谱' }).click()
  await expect(page).toHaveURL(new RegExp(`/collection/${profileId}/graph$`))
  // 返回 is a link to where it leads: the detail that opened the graph.
  await opensInNewTab(
    page,
    page.getByRole('link', { name: '返回', exact: true }),
    new RegExp(`/collection/${profileId}$`),
  )
})

test('the graph card and the compare page open in a new tab', async ({
  page,
}) => {
  await mock(page)
  await page.goto(`/collection/${profileId}/graph`)
  await page
    .getByRole('group', { name: '显示方式' })
    .getByRole('button', { name: '列表' })
    .click()
  // Cmd-click on an entry opens its page; a plain one, its card.
  const friend = page.locator('.person', { hasText: '朋友' })
  await opensInNewTab(page, friend, new RegExp(`/collection/${friendId}$`))
  await friend.click()
  const card = page.getByRole('region', { name: '账号' })
  await opensInNewTab(
    page,
    card.getByRole('link', { name: '以他为中心' }),
    new RegExp(`/collection/${friendId}/graph$`),
  )
  await opensInNewTab(
    page,
    card.getByRole('link', { name: '打开详情' }),
    new RegExp(`/collection/${friendId}$`),
  )
  const original = card.getByRole('link', { name: '打开原文' })
  await expect(original).toHaveAttribute('href', 'https://x.com/friend')
  await expect(original).toHaveAttribute('target', '_blank')
  await expect(original).toHaveAttribute('rel', 'noopener noreferrer')

  await page.goto(`/compare?rel_of=${KEY}&rel_of=${FRIEND}`)
  await opensInNewTab(
    page,
    page.getByRole('link', { name: '在收藏库中查看' }),
    /\/\?.*rel_of=/,
  )
  const shared = page.locator('.person', { hasText: '共同关注' })
  await opensInNewTab(page, shared, new RegExp(`/collection/${postId}$`))
  await shared.click()
  await opensInNewTab(
    page,
    page.getByRole('region', { name: '账号' }).getByRole('link', {
      name: '打开详情',
    }),
    new RegExp(`/collection/${postId}$`),
  )
})

test('the Mini App follows a modified click in place', async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(globalThis, {
      Telegram: {
        WebApp: {
          initData: 'signed',
          themeParams: {},
          colorScheme: 'light',
          ready() {},
          expand() {},
          onEvent() {},
          offEvent() {},
          BackButton: {
            show() {},
            hide() {},
            onClick() {},
            offClick() {},
          },
          openTelegramLink() {},
        },
      },
    })
  })
  await mock(page)
  const tabs: Page[] = []
  page.context().on('page', (tab) => tabs.push(tab))
  await page.goto(`/collection/${profileId}`)
  await page
    .getByRole('link', { name: '统计趋势' })
    .click({ modifiers: ['ControlOrMeta'] })
  await expect(page).toHaveURL(new RegExp(`/collection/${profileId}/stats$`))
  await page.goBack()
  await page.getByRole('link', { name: '关系图谱' }).click({ button: 'middle' })
  await expect(page).toHaveURL(new RegExp(`/collection/${profileId}/graph$`))
  expect(tabs).toEqual([])
})
