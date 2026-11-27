import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp, nextTick, vaporInteropPlugin } from 'vue'
import { APIError } from '../api'
import App from '../App.vue'
import { router } from '../router'
import { followShare } from '../share'
import { asset, collection, entity, mockApi } from '../testing/api'

const SLUG = 'AbCdEfGhIjKlMnOpQrStUv_-'
const POST = '00000000-0000-7000-8000-000000000001'
const PROFILE = '00000000-0000-7000-8000-000000000002'
const OTHER = '00000000-0000-7000-8000-000000000003'

const post = collection({
  id: POST,
  text: '公开的帖子',
  assets: [asset({ id: 'img', url: '/media/a', sensitive: true })],
  graph: {
    root: 'root',
    entities: [
      entity({ key: 'root', type: 'x.post', external_id: '1' }),
      entity({
        key: 'author',
        type: 'x.profile',
        external_id: '2',
        data: { name: '作者', username: 'writer' },
        saved_collection_id: PROFILE,
      }),
    ],
    relations: [{ source: 'root', target: 'author', type: 'authored_by' }],
  },
})
const profile = collection({
  id: PROFILE,
  text: '账号简介',
  graph: {
    root: 'root',
    entities: [
      entity({
        key: 'root',
        type: 'x.profile',
        external_id: '2',
        data: { name: '作者', username: 'writer' },
        assets: [
          asset({
            id: 'banner',
            purpose: 'banner',
            url: '/media/banner',
            thumbnail_url: '/media/banner-600x200',
          }),
        ],
      }),
    ],
    relations: [],
  },
})

let share: unknown
let api: ReturnType<typeof mockApi>
const paths = () => api.mock.calls.map(([path]) => String(path))

beforeEach(() => {
  vi.spyOn(globalThis, 'scrollTo').mockImplementation(() => {})
  api = mockApi((path) => {
    if (!path.startsWith(`/public/${SLUG}`)) throw new APIError(401, '需要登录')
    const rest = path.slice(`/public/${SLUG}`.length)
    if (rest === '') {
      if (!share) throw new APIError(404, '内容不存在或已删除')
      return share
    }
    if (rest.startsWith('/collections/count?'))
      return (
        new URLSearchParams(rest.split('?', 2)[1]).get('entity_type') ?? ''
      ).includes('.profile')
        ? { count: 56, types: { 'x.profile': 56 } }
        : { count: 1234, types: { 'x.post': 1234 } }
    if (rest.startsWith('/collections/authors'))
      return { items: [{ id: 'x/x.profile/2', name: '作者', count: 1 }] }
    if (rest === '/collections' || rest.startsWith('/collections?'))
      return {
        items: [
          (
            new URLSearchParams(rest.split('?', 2)[1]).get('entity_type') ?? ''
          ).includes('.profile')
            ? profile
            : post,
        ],
      }
    if (rest === `/collections/${POST}`) return post
    if (rest === `/collections/${PROFILE}`) return profile
    if (rest.includes('/history')) return { items: [] }
    if (rest.includes('/counts')) return { points: [] }
    if (rest.includes('/profile-changes')) return { items: [] }
    if (rest === `/collections/${PROFILE}/follows`)
      return { following: 3, followers: 5, mutual: 1 }
    if (rest.startsWith(`/collections/${PROFILE}/follow-changes`))
      return {
        items: [
          {
            type: 'unfollow',
            observed_at: '2026-11-02T00:00:00.000Z',
            account: { entity_id: 'e', external_id: '9', name: '别人' },
          },
        ],
      }
    throw new APIError(404, '内容不存在或已删除')
  })
})
let unmount = () => {}
afterEach(() => {
  unmount()
  document.body.replaceChildren()
  location.hash = '/'
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

followShare(router)

async function mount(path: string) {
  location.hash = path
  await router.push(path)
  const el = document.createElement('div')
  document.body.append(el)
  const app = createApp(App).use(vaporInteropPlugin).use(router)
  await router.isReady()
  app.mount(el)
  unmount = () => app.unmount()
  return el
}
const buttons = (el: HTMLElement) =>
  [...el.querySelectorAll('button')].map((b) => b.textContent?.trim())

it('opens a shared folder without login, with a tab per kind it holds', async () => {
  share = { target: 'folder', name: '精选', posts: 1, profiles: 1 }
  const el = await mount(`/s/${SLUG}`)
  await vi.waitFor(() => expect(el.textContent).toContain('公开的帖子'))
  expect(el.querySelector('h1')?.textContent).toBe('精选')
  // Counted within the share, for the tab shown.
  await vi.waitFor(() =>
    expect(el.querySelector('.total')?.textContent).toBe('1,234条'),
  )
  // Items open inside the share.
  expect(
    el.querySelector<HTMLAnchorElement>('a.head')?.getAttribute('href'),
  ).toBe(`/s/${SLUG}/collection/${POST}`)
  // Nothing of the owner's: no batch update, no login.
  expect(buttons(el)).not.toContain('多选')
  expect(paths().every((path) => path.startsWith('/public/'))).toBe(true)

  const tab = [...el.querySelectorAll<HTMLButtonElement>('[role=tab]')].find(
    (b) => b.textContent?.trim() === '账号',
  )!
  tab.click()
  await vi.waitFor(() => expect(el.textContent).toContain('账号简介'))
  await vi.waitFor(() =>
    expect(el.querySelector('.total')?.textContent).toBe('56个账号'),
  )
  // The tab is in the address, so it can be linked.
  expect(router.currentRoute.value.query.entity_type).toBe(
    'x.profile,instagram.profile',
  )
  const query = new URLSearchParams(
    paths()
      .findLast((path) => path.startsWith(`/public/${SLUG}/collections?`))!
      .split('?', 2)[1],
  )
  expect(query.get('entity_type')).toBe('x.profile,instagram.profile')
  // Accounts have no post time and their save time is the owner's: the
  // ones updated last come first; their public counts order them too.
  expect(query.get('sort')).toBe('updated')
  await vi.waitFor(() =>
    expect(
      el.querySelector<HTMLSelectElement>('select[aria-label=排序]')?.value,
    ).toBe('updated'),
  )
  expect(
    [
      ...el.querySelector<HTMLSelectElement>('select[aria-label=排序]')!
        .options,
    ].map((option) => option.textContent?.trim()),
  ).toEqual(['更新时间', '粉丝数', '关注数'])
})

it('filters a shared folder newest posts first, without tags', async () => {
  share = { target: 'folder', name: '精选', posts: 1, profiles: 0 }
  const el = await mount(`/s/${SLUG}`)
  await vi.waitFor(() => expect(el.textContent).toContain('公开的帖子'))
  const listed = () =>
    paths()
      .filter((path) => path.startsWith(`/public/${SLUG}/collections?`))
      .map((path) => new URLSearchParams(path.split('?', 2)[1]))
  const counted = () =>
    paths()
      .filter((path) => path.startsWith(`/public/${SLUG}/collections/count?`))
      .map((path) => new URLSearchParams(path.split('?', 2)[1]))
  // Published, newest first, whatever the folder keeps.
  expect(listed()[0]!.get('sort')).toBe('published')
  expect(listed()[0]!.get('order')).toBeNull()
  const sort = el.querySelector<HTMLSelectElement>('select[aria-label=排序]')!
  expect(sort.value).toBe('published')
  expect([...sort.options].map((option) => option.textContent?.trim())).toEqual(
    ['发帖时间', '更新时间'],
  )
  expect(
    el.querySelector<HTMLSelectElement>('select[aria-label=排序方向]')!.value,
  ).toBe('desc')

  // The filters are there; the owner's tags and save dates are not.
  ;[...el.querySelectorAll('button')]
    .find((b) => b.textContent?.trim().startsWith('筛选'))!
    .click()
  await nextTick()
  expect(el.querySelector('.panel')).not.toBeNull()
  expect(el.textContent).not.toContain('标签')
  expect(el.querySelector('[aria-label=标签筛选]')).toBeNull()
  expect(el.textContent).not.toContain('收藏日期')
  expect(el.querySelector('[aria-label=收藏日期]')).toBeNull()

  // A choice goes to the address and to the public list.
  const postType = el.querySelector<HTMLSelectElement>(
    'select[aria-label=帖子类型]',
  )!
  postType.value = 'quote'
  postType.dispatchEvent(new Event('change'))
  await vi.waitFor(() =>
    expect(router.currentRoute.value.query.post_type).toBe('quote'),
  )
  await vi.waitFor(() =>
    expect(listed().at(-1)!.get('post_type')).toBe('quote'),
  )

  // The author picker reads the share's own authors.
  const picker = el.querySelector<HTMLDetailsElement>('details.multi-select')!
  picker.open = true
  picker.dispatchEvent(new Event('toggle'))
  await vi.waitFor(() =>
    expect(paths()).toContainEqual(
      expect.stringMatching(new RegExp(`^/public/${SLUG}/collections/authors`)),
    ),
  )
  // A tag, a save date, a 关系 filter or a private order in the address is
  // never sent.
  const before = listed().length
  await router.push(
    `/s/${SLUG}?tag=00000000-0000-7000-8000-00000000000a&tag_mode=all&not_tag=00000000-0000-7000-8000-00000000000b&from_date=2026-01-01&to_date=2026-02-01&saved_within=7d&tz=UTC&sort=storage&rel_of=x%2Fx.profile%2F1&rel=following`,
  )
  await vi.waitFor(() => expect(listed().length).toBeGreaterThan(before))
  for (const key of [
    'tag',
    'tag_mode',
    'not_tag',
    'saved_from',
    'saved_before',
    'saved_within',
    'tz',
    'rel_of',
    'rel',
  ])
    expect([...listed(), ...counted()].every((q) => !q.has(key))).toBe(true)
  expect(counted().some((q) => q.get('post_type') === 'quote')).toBe(true)
  expect(listed().at(-1)!.get('sort')).toBe('published')
  expect(paths().every((path) => path.startsWith('/public/'))).toBe(true)
})

it('shows a shared post read-only, its links kept inside the share', async () => {
  share = { target: 'collection', collection_id: POST }
  const el = await mount(`/s/${SLUG}`)
  await vi.waitFor(() => expect(el.textContent).toContain('公开的帖子'))
  for (const label of [
    '正在更新',
    '查看进度',
    '删除这条收藏',
    '公开分享',
    '我的整理',
  ])
    expect(el.textContent).not.toContain(label)
  expect(
    [...el.querySelectorAll('a')].some(
      (a) => a.getAttribute('href') === `/s/${SLUG}/collection/${PROFILE}`,
    ),
  ).toBe(true)
  // Sensitive media starts covered.
  expect(el.querySelector('img[src="/media/a"]')).toBeNull()
  expect(paths().every((path) => path.startsWith('/public/'))).toBe(true)

  await router.push(`/s/${SLUG}/collection/${PROFILE}`)
  await vi.waitFor(() => expect(el.textContent).toContain('账号简介'))
  // The profile's posts are listed through the share.
  await vi.waitFor(() =>
    expect(paths()).toContainEqual(
      expect.stringMatching(
        new RegExp(
          String.raw`^/public/${SLUG}/collections\?related_to=${PROFILE}`,
        ),
      ),
    ),
  )
  // Its follows are shared with it, and their page stays in the share.
  await vi.waitFor(() => expect(el.textContent).toContain('关系网'))
  // One entry, 历史, whose 关注 tab stays in the share.
  const history = await vi.waitFor(() => {
    const found = [...el.querySelectorAll('a')].find((a) =>
      a.textContent?.trim().startsWith('历史'),
    )
    expect(found).toBeDefined()
    return found!
  })
  expect(history.getAttribute('href')).toMatch(
    new RegExp(`^/s/${SLUG}/collection/${PROFILE}/history`),
  )
  history.click()
  const tab = await vi.waitFor(() => {
    const found = [...el.querySelectorAll<HTMLAnchorElement>('nav a')].find(
      (a) => a.textContent?.trim() === '关注',
    )
    expect(found).toBeDefined()
    return found!
  })
  expect(tab.getAttribute('href')).toBe(
    `/app/s/${SLUG}/collection/${PROFILE}/history/follows`,
  )
  tab.click()
  await vi.waitFor(() =>
    expect(router.currentRoute.value.name).toBe(
      'share-collection-history-follows',
    ),
  )
  await vi.waitFor(() => expect(el.textContent).toContain('别人'))
  expect(el.querySelector('h1')?.textContent).toBe('历史')
  expect(paths().every((path) => path.startsWith('/public/'))).toBe(true)
  await nextTick()
})

it("shows a shared profile's banner, to open like the owner's", async () => {
  share = { target: 'collection', collection_id: PROFILE }
  const el = await mount(`/s/${SLUG}`)
  await vi.waitFor(() => expect(el.textContent).toContain('账号简介'))
  expect(el.querySelector('.cover img')?.getAttribute('src')).toBe(
    '/media/banner-600x200',
  )
  expect(el.querySelector('.cover button')?.getAttribute('aria-label')).toBe(
    '查看作者的主页封面',
  )
  expect(paths().every((path) => path.startsWith('/public/'))).toBe(true)
})

it('says so when the link is gone', async () => {
  share = undefined
  const el = await mount(`/s/${SLUG}`)
  await vi.waitFor(() =>
    expect(el.querySelector('[role=alert]')?.textContent).toBe(
      '链接不存在或已取消公开',
    ),
  )
  expect(paths()).toEqual([`/public/${SLUG}`])
  // A collection outside the share is not found either.
  await router.push(`/s/${SLUG}/collection/${OTHER}`)
  expect(paths().every((path) => path.startsWith('/public/'))).toBe(true)
})
