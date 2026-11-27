import type { Page } from '@playwright/test'

/** A small library for the desktop layout: posts, an account, folders. */
export const PROFILE_ID = '22222222-2222-4222-8222-222222222222'
export const POST_ID = '11111111-1111-4111-8111-000000000000'
export const QUOTED_ID = '33333333-3333-4333-8333-333333333333'
/** Public links: a folder's, and the account's. */
export const FOLDER_SLUG = 'FolderShareFolderShare01'
export const PROFILE_SLUG = 'ProfileShareProfileShar1'
const PUBLIC = /^\/v1\/public\/([\w-]+)(\/.*)?$/

const image = (hue: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><defs><linearGradient id="s" x2="0" y2="1"><stop stop-color="hsl(${hue} 45% 35%)"/><stop offset="1" stop-color="hsl(${hue + 40} 55% 75%)"/></linearGradient></defs><path fill="url(#s)" d="M0 0h1200v800H0z"/><circle cx="880" cy="260" r="90" fill="#ffe6af"/><path d="M0 560 380 300 760 560 1200 420v380H0" fill="rgba(0,0,0,.35)"/></svg>`

/** Long words that do not wrap by themselves, as X accounts have them. */
const LONG_URL =
  'https://example.com/a-very-long-path/that/never/breaks/on/its/own/because-it-has-no-spaces/and-keeps-going?utm_source=midden&utm_medium=profile&utm_campaign=overflow'
const author = {
  key: 'author',
  type: 'x.profile',
  external_id: '7',
  saved_collection_id: PROFILE_ID,
  data: {
    name: '山野记录',
    username: 'mountain_log',
    metadata: {
      description: `记录山野与城市之间的日常。摄影、徒步、偶尔写字。\n${LONG_URL}\n#一个很长很长的标签没有空格一个很长很长的标签没有空格一个很长很长的标签没有空格`,
      location:
        'Somewhere-over-the-rainbow-way-up-high-and-the-dreams-that-you-dream-of',
      url: LONG_URL,
      followers: 123_456_789,
      following: 98_765,
      statuses: 1_234_567,
      media_count: 45_678,
      likes: 9_876_543,
    },
  },
}
const photo = (id: string, width = 1200, height = 800) => ({
  id,
  url: `/v1/assets/${id}?inline=1`,
  download_url: `/v1/assets/${id}?download=1`,
  file_name: `${id}.svg`,
  state: 'ready',
  mime: 'image/svg+xml',
  sensitive: false,
  width,
  height,
})
export const posts = Array.from({ length: 24 }, (_, index) => ({
  id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
  url: `https://x.com/mountain_log/status/${1000 + index}`,
  text:
    index === 0
      ? '今天在山顶看到了云海，风很大但很值得。下山时顺路去了湖边，水面像镜子一样。'
      : `第 ${index + 1} 条收藏：一段关于旅行、摄影和日常的记录。`,
  author_name: '山野记录',
  saved_at: `2026-11-${String(25 - (index % 20)).padStart(2, '0')}T10:00:00Z`,
  observed_at: '2026-11-25T10:00:00Z',
  published_at: '2026-11-24T08:00:00Z',
  revision_id: `r${index}`,
  storage_bytes: 2_400_000 + index * 10_000,
  // Some wide, as banners and panoramas are.
  assets:
    index % 3 === 0
      ? [index % 2 ? photo(`p${index}`, 3000, 1000) : photo(`p${index}`)]
      : [],
  graph: {
    root: 'post',
    entities: [
      {
        key: 'post',
        type: 'x.post',
        external_id: String(1000 + index),
        data: {},
      },
      author,
      ...(index === 0
        ? [
            {
              key: 'quoted',
              type: 'x.post',
              external_id: '900',
              saved_collection_id: QUOTED_ID,
              data: { text: '被引用的一条帖子：秋天的第一场雪。' },
            },
          ]
        : []),
    ],
    relations: [
      { source: 'post', target: 'author', type: 'authored_by' },
      ...(index === 0
        ? [{ source: 'post', target: 'quoted', type: 'quoted' }]
        : []),
    ],
  },
}))
export const profile = {
  id: PROFILE_ID,
  url: 'https://x.com/mountain_log',
  text: `记录山野与城市之间的日常。摄影、徒步、偶尔写字。\n${LONG_URL}\n#一个很长很长的标签没有空格一个很长很长的标签没有空格一个很长很长的标签没有空格`,
  author_name: '山野记录',
  saved_at: '2026-10-01T10:00:00Z',
  observed_at: '2026-11-25T10:00:00Z',
  revision_id: 'rp',
  storage_bytes: 182_000_000,
  assets: [{ ...photo('banner', 1500, 500), purpose: 'banner' }],
  graph: {
    root: 'author',
    entities: [author],
    relations: [],
  },
}
const OWN = 'x/x.profile/1'
const graph = {
  nodes: [
    {
      entity_id: 'c',
      key: 'x/x.profile/7',
      external_id: '7',
      name: '山野记录',
    },
    ...Array.from({ length: 30 }, (_, i) => ({
      entity_id: `n${i}`,
      key: `x/x.profile/${100 + i}`,
      external_id: String(100 + i),
      name: `朋友 ${i + 1}`,
      kind: i % 3 === 0 ? 'mutual' : i % 3 === 1 ? 'following' : 'followers',
      followers: 1000 - i * 10,
    })),
  ],
  edges: [],
  total: 30,
  kinds: { following: 10, followers: 10, mutual: 10 },
  lists: { following: {}, followers: {} },
}
export const folders = [
  {
    id: 'f0000000-0000-4000-8000-000000000001',
    name: '风景摄影',
    filter: 'media_type=image',
    count: 128,
    types: { 'x.post': 128 },
  },
  {
    id: 'f0000000-0000-4000-8000-000000000002',
    name: '旅行计划',
    filter: 'q=%E6%97%85%E8%A1%8C',
    count: 42,
    types: { 'x.post': 42 },
  },
]

const DIGITS = /\d+/

/** Answer the app's requests from the library above. */
export async function mockDesktop(page: Page) {
  const searches: string[] = []
  await page.route('https://telegram.org/**', (r) => r.fulfill({ body: '' }))
  await page.route('**/v1/**', (r) => {
    const url = new URL(r.request().url())
    let path = url.pathname
    // A public link reads the same library through its own address.
    const shared = PUBLIC.exec(path)
    if (shared) {
      const [, slug, rest] = shared
      if (!rest)
        return r.fulfill({
          json:
            slug === PROFILE_SLUG
              ? { target: 'collection', collection_id: PROFILE_ID }
              : {
                  target: 'folder',
                  name: '公开的风景',
                  posts: 128,
                  profiles: 0,
                },
        })
      path = `/v1${rest}`
    }
    const json = (body: unknown) => r.fulfill({ json: body })
    if (path.startsWith('/v1/assets/'))
      return r.fulfill({
        contentType: 'image/svg+xml',
        body: image((Number(DIGITS.exec(path)?.[0]) || 0) * 37),
      })
    if (path === '/v1/collections') {
      if (url.searchParams.get('q')) searches.push(url.searchParams.get('q')!)
      return json({ items: posts })
    }
    if (path === '/v1/collections/count')
      return json({ count: 1280, types: { 'x.post': 1280 } })
    if (path === '/v1/folders') return json(folders)
    if (path === '/v1/usage') return json({ used_bytes: 12_800_000_000 })
    if (path === '/v1/tags') return json([])
    if (path === '/v1/accounts')
      return json({
        platforms: [
          {
            id: 'x',
            name: 'X',
            public: false,
            can_add: true,
            selected_account_id: 'a1',
          },
        ],
        accounts: [
          {
            id: 'a1',
            name: '主账号',
            username: 'midden_owner',
            state: 'ok',
            platform: 'x',
            selected: true,
          },
        ],
      })
    if (path === '/v1/instance')
      return json({ dev: false, litestream: { enabled: false } })
    if (path === '/v1/collections/perspectives')
      return json({
        items: [
          {
            id: OWN,
            username: 'midden_owner',
            following: {},
            followers: {},
            own: true,
          },
        ],
      })
    if (path === '/v1/collections/graph' || path.endsWith('/graph'))
      return json(graph)
    if (path.endsWith('/history'))
      return json({
        items: [
          {
            capture_id: 'c3',
            observed_at: '2026-11-25T10:00:00Z',
            revision_id: 'r3',
          },
          {
            capture_id: 'c2',
            observed_at: '2026-11-10T10:00:00Z',
            revision_id: 'r2',
          },
          {
            capture_id: 'c1',
            observed_at: '2026-10-01T10:00:00Z',
            revision_id: 'r1',
          },
        ],
      })
    if (path.endsWith('/follows'))
      return json({ following: 312, followers: 4820, mutual: 156 })
    if (path.endsWith('/availability')) return json({ available: true })
    if (path.endsWith('/annotation')) return json({ note: '', tags: [] })
    if (path.endsWith('/update')) return json({ older: false })
    if (path === '/v1/watches')
      return json({
        items:
          url.searchParams.get('id') === PROFILE_ID
            ? [
                {
                  id: 'w1',
                  target: 'collection',
                  target_id: PROFILE_ID,
                  every: { count: 1, unit: 'day' },
                  time_zone: 'UTC',
                  enabled: true,
                  next_run_at: '2026-11-27T03:00:00Z',
                },
              ]
            : [],
      })
    if (path === '/v1/queue')
      return json({
        control: { paused: false, types: [] },
        pausable: ['thumbnail', 'upload', 'raw-upload'],
        backlog: [{ type: 'capture', waiting: 3, running: 1, paused: 0 }],
        rate_limits: [],
        worker: null,
        web: null,
      })
    if (path === '/v1/shares') return json([])
    if (
      path === '/v1/origins' ||
      path === '/v1/tokens' ||
      path.endsWith('/passkeys')
    )
      return json([])
    const item = [...posts, profile].find(
      (i) => path === `/v1/collections/${i.id}`,
    )
    if (item) return json(item)
    if (path === `/v1/collections/${QUOTED_ID}`)
      return json({
        ...posts[1]!,
        id: QUOTED_ID,
        text: '被引用的一条帖子：秋天的第一场雪。',
      })
    return json({ items: [] })
  })
  return { searches }
}
