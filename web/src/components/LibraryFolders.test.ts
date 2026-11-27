import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp, nextTick, vaporInteropPlugin } from 'vue'
import { APIError, type Folder } from '../api'
import { toastState } from '../composables/useToast'
import { router } from '../router'
import { mockApi, type Request } from '../testing/api'
import CollectionLibrary from './CollectionLibrary.vue'

const FOLDER = '00000000-0000-7000-8000-00000000000f'
const folder = (fields: Partial<Folder>): Folder => ({
  id: FOLDER,
  name: '图片',
  query: 'has:image',
  filter: 'media_type=image',
  sort: '',
  order: '',
  tz: '',
  count: 3,
  types: { 'x.post': 3 },
  counted_at: '2026-11-01T00:00:00.000Z',
  stale: false,
  created_at: '2026-11-01T00:00:00.000Z',
  updated_at: '2026-11-01T00:00:00.000Z',
  ...fields,
})

let folders: Folder[] = []
/** What `/collections/count` answers, by entity type. */
let counts: Record<string, number> = {}
let api: ReturnType<typeof mockApi>
const sent = (method: string, path: string) =>
  api.mock.calls
    .filter(([p, r]) => r.method === method && p === path)
    .map(([, r]) => JSON.parse((r as Request).body ?? 'null'))

beforeEach(() => {
  vi.spyOn(globalThis, 'scrollTo').mockImplementation(() => {})
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.open = true
  })
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.open = false
  })
  folders = [
    folder({}),
    folder({
      id: '00000000-0000-7000-8000-0000000000aa',
      name: '账号们',
      filter: 'visibility=private',
      count: 1,
      types: { 'x.profile': 1 },
    }),
  ]
  counts = {}
  api = mockApi((path, request) => {
    if (path === '/folders') {
      if (request.method === 'POST') {
        const created = folder({
          ...JSON.parse(request.body!),
          id: '00000000-0000-7000-8000-0000000000bb',
          count: 7,
          // Counted as the server would, when a test says.
          ...(Object.keys(counts).length ? { types: counts } : {}),
        })
        folders = [...folders, created]
        return created
      }
      return folders
    }
    if (path.startsWith('/folders/')) {
      const id = path.slice('/folders/'.length)
      if (request.method === 'DELETE') {
        folders = folders.filter((f) => f.id !== id)
        return
      }
      const changed = {
        ...folders.find((f) => f.id === id)!,
        ...JSON.parse(request.body!),
      }
      folders = folders.map((f) => (f.id === id ? changed : f))
      return changed
    }
    if (path.startsWith('/collections/count?')) {
      const named = new URLSearchParams(path.split('?', 2)[1])
        .get('entity_type')
        ?.split(',')
        .filter(Boolean)
      const types = Object.fromEntries(
        Object.entries(counts).filter(
          ([type]) => !named?.length || named.includes(type),
        ),
      )
      return {
        count: Object.values(types).reduce((a, b) => a + b, 0),
        types,
      }
    }
    if (path.startsWith('/collections?')) return { items: [] }
    if (path === '/tags') return []
    if (path === '/updates/preview')
      return { posts: 3, profiles: 0, listable: 0, name: '图片' }
    if (path === '/updates') return { id: 'record' }
    if (path.startsWith('/captures/')) throw new APIError(404, '不存在')
    return { used_bytes: 0 }
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

async function mount(path: string) {
  location.hash = path
  await router.push(path)
  const el = document.createElement('div')
  document.body.append(el)
  const app = createApp(CollectionLibrary).use(vaporInteropPlugin).use(router)
  await router.isReady()
  app.mount(el)
  unmount = () => app.unmount()
  return el
}
const button = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === text,
  )!
const listQueries = () =>
  api.mock.calls
    .map(([path]) => String(path))
    .filter((path) => path.startsWith('/collections?'))
    .map((path) => new URLSearchParams(path.split('?', 2)[1]))
/**
 * Counts asked to learn which kinds a folder's results hold: over both
 * kinds, unlike the total each tab counts for itself.
 */
const kindCounts = () =>
  api.mock.calls
    .map(([path]) => String(path))
    .filter((path) => path.startsWith('/collections/count?'))
    .filter((path) => {
      const types = new URLSearchParams(path.split('?', 2)[1])
        .get('entity_type')
        ?.split(',')
      return (
        !types || new Set(types.map((t) => t.endsWith('.profile'))).size > 1
      )
    })

it('lists every folder and saves the current filters as one', async () => {
  const el = await mount('/?media_type=video')
  // Whichever tab is shown, posts' and accounts' folders alike.
  await vi.waitFor(() =>
    expect(el.querySelector('nav[aria-label="收藏夹"]')?.textContent).toBe(
      '图片3账号们1',
    ),
  )
  button(el, '存为收藏夹').click()
  await nextTick()
  const input = el.querySelector<HTMLInputElement>('dialog[open] input')!
  input.value = ' 视频 '
  input.dispatchEvent(new Event('input'))
  input.form!.requestSubmit()
  await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('folder'))
  // Posts and accounts alike: the folder opens on the tab it was saved
  // from, which is not part of its filter.
  expect(sent('POST', '/folders')).toEqual([
    { name: '视频', filter: 'media_type=video' },
  ])
  expect(router.currentRoute.value.query.tab).toBe('post')
  await vi.waitFor(() =>
    expect(el.querySelector('h1')!.textContent).toBe('视频'),
  )
  expect(el.querySelector('.folder-status')).toBeNull()
})

it('saves the 账号 tab as a folder of both kinds, opened on accounts', async () => {
  counts = { 'x.post': 4, 'x.profile': 7 }
  const el = await mount('/?entity_type=x.profile,instagram.profile&q=cat')
  await vi.waitFor(() => expect(button(el, '存为收藏夹')).toBeDefined())
  button(el, '存为收藏夹').click()
  await nextTick()
  const input = el.querySelector<HTMLInputElement>('dialog[open] input')!
  input.value = '猫'
  input.dispatchEvent(new Event('input'))
  input.form!.requestSubmit()
  await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('folder'))
  expect(sent('POST', '/folders')).toEqual([{ name: '猫', filter: 'q=cat' }])
  expect(router.currentRoute.value.query.tab).toBe('profile')
  await vi.waitFor(() =>
    expect(listQueries().at(-1)?.get('entity_type')).toBe(
      'x.profile,instagram.profile',
    ),
  )
  expect(el.querySelector('.folder-status')).toBeNull()
})

it('opens a bare folder address at its filter and updates it once changed', async () => {
  const el = await mount(`/folder/${FOLDER}`)
  await vi.waitFor(() =>
    expect(
      new URLSearchParams(router.currentRoute.value.query as never).get(
        'media_type',
      ),
    ).toBe('image'),
  )
  await vi.waitFor(() =>
    expect(listQueries().at(-1)?.get('media_type')).toBe('image'),
  )
  expect(el.querySelector('h1')!.textContent).toBe('图片')
  expect(el.querySelector('.folder-status')).toBeNull()
  // Saving only applies to a list that is not a folder already.
  expect(button(el, '存为收藏夹')).toBeUndefined()

  await router.push(`/folder/${FOLDER}?media_type=image&order=asc`)
  await vi.waitFor(() =>
    expect(el.querySelector('.folder-status')?.textContent).toContain(
      '筛选条件已修改',
    ),
  )
  button(el, '保存条件').click()
  await vi.waitFor(() => expect(el.querySelector('.folder-status')).toBeNull())
  expect(toastState.value?.text).toBe('已保存条件')
  expect(sent('PATCH', `/folders/${FOLDER}`)).toEqual([
    { filter: 'media_type=image&order=asc' },
  ])
})

it('renames and deletes the open folder', async () => {
  const el = await mount(`/folder/${FOLDER}`)
  await vi.waitFor(() =>
    expect(el.querySelector('h1')!.textContent).toBe('图片'),
  )
  el.querySelector<HTMLButtonElement>('[aria-label="管理收藏夹"]')!.click()
  await nextTick()
  button(el, '重命名').click()
  await nextTick()
  const input = el.querySelector<HTMLInputElement>('dialog[open] input')!
  expect(input.value).toBe('图片')
  input.value = '好图'
  input.dispatchEvent(new Event('input'))
  input.form!.requestSubmit()
  await vi.waitFor(() =>
    expect(el.querySelector('h1')!.textContent).toBe('好图'),
  )
  expect(sent('PATCH', `/folders/${FOLDER}`)).toEqual([{ name: '好图' }])

  el.querySelector<HTMLButtonElement>('[aria-label="管理收藏夹"]')!.click()
  await nextTick()
  button(el, '删除收藏夹').click()
  await nextTick()
  const confirm = [
    ...el.querySelectorAll<HTMLButtonElement>('dialog[open] button'),
  ].find((b) => b.textContent?.trim() === '删除收藏夹')!
  confirm.click()
  await vi.waitFor(() =>
    expect(router.currentRoute.value.name).toBe('collections'),
  )
  expect(
    api.mock.calls.some(
      ([p, r]) => r.method === 'DELETE' && p === `/folders/${FOLDER}`,
    ),
  ).toBe(true)
})

it('updates the open folder from its menu, then links to the progress', async () => {
  vi.stubGlobal('crypto', { randomUUID: () => 'key' })
  const el = await mount(`/folder/${FOLDER}`)
  await vi.waitFor(() =>
    expect(el.querySelector('h1')!.textContent).toBe('图片'),
  )
  el.querySelector<HTMLButtonElement>('[aria-label="管理收藏夹"]')!.click()
  await nextTick()
  expect(el.textContent).not.toContain('查看更新进度')
  button(el, '更新收藏夹').click()
  await vi.waitFor(() =>
    expect(el.querySelector('dialog[open] .sheet-title')?.textContent).toBe(
      '更新 3条帖子',
    ),
  )
  await vi.waitFor(() => expect(button(el, '开始更新').disabled).toBe(false))
  button(el, '开始更新').click()
  await vi.waitFor(() => expect(sent('POST', '/updates')).toHaveLength(1))
  // The defaults, as everywhere a capture starts.
  expect(sent('POST', '/updates')).toEqual([
    {
      target: { target: 'folder', id: FOLDER },
      options: {
        posts: 'latest',
        count: 100,
        media_only: false,
        include_shared: true,
        capture_references: true,
        relations: false,
      },
    },
  ])
  // The sheet closes once the update started.
  await vi.waitFor(() => expect(el.querySelector('dialog[open]')).toBeNull())
  el.querySelector<HTMLButtonElement>('[aria-label="管理收藏夹"]')!.click()
  await vi.waitFor(() => expect(el.textContent).toContain('查看更新进度'))
  const progress = [...el.querySelectorAll('a')].find(
    (a) => a.textContent?.trim() === '查看更新进度',
  )!
  expect(progress.getAttribute('href')).toBe('/captures/record')
  progress.click()
  await vi.waitFor(() =>
    expect(router.currentRoute.value).toMatchObject({
      name: 'capture',
      params: { id: 'record' },
    }),
  )
})

it('says so when the folder is gone', async () => {
  const el = await mount('/folder/00000000-0000-7000-8000-0000000000ff')
  await vi.waitFor(() =>
    expect(el.textContent).toContain('收藏夹不存在或已删除'),
  )
})

const MIXED = '00000000-0000-7000-8000-0000000000cc'
const tabs = (el: HTMLElement) =>
  [...el.querySelectorAll('[role="tab"]')].map((tab) => [
    tab.textContent?.trim(),
    tab.getAttribute('aria-selected'),
  ])

it('splits a folder of posts and accounts into tabs, as a view', async () => {
  folders.push(
    folder({
      id: MIXED,
      name: '私密',
      filter: 'visibility=private',
      count: 5,
      types: { 'x.post': 3, 'instagram.profile': 2 },
    }),
  )
  const el = await mount(`/folder/${MIXED}`)
  await vi.waitFor(() =>
    expect(tabs(el)).toEqual([
      ['帖子', 'true'],
      ['账号', 'false'],
    ]),
  )
  await vi.waitFor(() =>
    expect(listQueries().at(-1)?.get('entity_type')).toBe(
      'x.post,instagram.post',
    ),
  )
  expect(listQueries().at(-1)?.get('visibility')).toBe('private')
  // The folder's own counts said both kinds are there.
  expect(kindCounts()).toEqual([])

  el.querySelectorAll<HTMLAnchorElement>('[role="tab"]')[1]!.click()
  await vi.waitFor(() =>
    expect(listQueries().at(-1)?.get('entity_type')).toBe(
      'x.profile,instagram.profile',
    ),
  )
  expect(tabs(el)).toEqual([
    ['帖子', 'false'],
    ['账号', 'true'],
  ])
  expect(listQueries().at(-1)?.get('sort')).toBe('saved')
  // Another tab is not another filter, nor one the filters offer.
  expect(el.querySelector('.folder-status')).toBeNull()
  expect(el.querySelector('select[aria-label="类型"]')).toBeNull()

  // A changed filter asks for its own counts: only accounts are left.
  counts = { 'x.profile': 1 }
  await router.push(`/folder/${MIXED}?visibility=public&tab=post`)
  await vi.waitFor(() => expect(tabs(el)).toEqual([]))
  await vi.waitFor(() =>
    expect(listQueries().at(-1)?.get('entity_type')).toBe(
      'x.profile,instagram.profile',
    ),
  )
  expect(kindCounts()).toHaveLength(1)
  expect(el.querySelector('.folder-status')?.textContent).toContain(
    '筛选条件已修改',
  )
  // Saved from the 账号 tab, the filter still holds both kinds.
  button(el, '保存条件').click()
  await vi.waitFor(() => expect(el.querySelector('.folder-status')).toBeNull())
  expect(sent('PATCH', `/folders/${MIXED}`)).toEqual([
    { filter: 'visibility=public' },
  ])
})

it("shows each tab's own total, counted again for other filters", async () => {
  counts = { 'x.post': 1234, 'instagram.post': 1, 'x.profile': 56 }
  const total = (el: HTMLElement) => el.querySelector('.total')?.textContent
  const totals = () =>
    api.mock.calls
      .map(([path]) => String(path))
      .filter((path) => path.startsWith('/collections/count?'))
      .map((path) => new URLSearchParams(path.split('?', 2)[1]))
  const el = await mount('/')
  await vi.waitFor(() => expect(total(el)).toBe('1,235 条'))

  el.querySelectorAll<HTMLAnchorElement>('[role="tab"]')[1]!.click()
  await vi.waitFor(() => expect(total(el)).toBe('56 个账号'))
  expect(totals().at(-1)?.get('entity_type')).toBe(
    'x.profile,instagram.profile',
  )

  // Back on a tab already shown: neither its list nor its total is asked again.
  const asked = totals().length
  el.querySelectorAll<HTMLAnchorElement>('[role="tab"]')[0]!.click()
  await vi.waitFor(() => expect(total(el)).toBe('1,235 条'))
  expect(totals()).toHaveLength(asked)

  counts = { 'x.post': 3 }
  await router.push('/?q=cat')
  await vi.waitFor(() => expect(total(el)).toBe('3 条'))
  expect(totals().at(-1)?.get('q')).toBe('cat')

  // A folder's tab counts its own kind.
  counts = { 'x.post': 3, 'instagram.profile': 2 }
  folders.push(
    folder({
      id: MIXED,
      name: '私密',
      filter: 'visibility=private',
      count: 5,
      types: counts,
    }),
  )
  await router.push(`/folder/${MIXED}?visibility=private&tab=profile`)
  await vi.waitFor(() => expect(total(el)).toBe('2 个账号'))
  expect(totals().at(-1)?.get('visibility')).toBe('private')
})

it('lists a folder holding one kind without tabs', async () => {
  folders.push(
    folder({
      id: MIXED,
      name: '全部',
      filter: 'q=cat',
      count: 2,
      types: { 'x.profile': 2 },
    }),
  )
  const el = await mount(`/folder/${MIXED}`)
  await vi.waitFor(() =>
    expect(listQueries().at(-1)?.get('entity_type')).toBe(
      'x.profile,instagram.profile',
    ),
  )
  expect(tabs(el)).toEqual([])
  expect(el.querySelector('.folder-status')).toBeNull()
})

it('saves a quick save-date range as a relative one', async () => {
  const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone
  const el = await mount('/')
  const range = await vi.waitFor(() =>
    el.querySelector<HTMLSelectElement>('select[aria-label="收藏日期"]')!,
  )
  expect([...range.options].map((o) => o.textContent?.trim())).toEqual([
    '全部',
    '今天',
    '最近7天',
    '最近30天',
    '自定义',
  ])
  range.value = '7d'
  range.dispatchEvent(new Event('change'))
  await vi.waitFor(() =>
    expect(listQueries().at(-1)?.get('saved_within')).toBe('7d'),
  )
  expect(listQueries().at(-1)?.get('tz')).toBe(zone)
  expect(listQueries().at(-1)?.has('saved_from')).toBe(false)
  expect(router.currentRoute.value.query.saved_within).toBe('7d')
  await vi.waitFor(() =>
    expect(el.querySelector('.filter-summary')?.textContent).toBe('最近7天'),
  )

  button(el, '存为收藏夹').click()
  await nextTick()
  const input = el.querySelector<HTMLInputElement>('dialog[open] input')!
  input.value = '本周'
  input.dispatchEvent(new Event('input'))
  input.form!.requestSubmit()
  await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('folder'))
  expect(sent('POST', '/folders')[0].filter).toBe(
    new URLSearchParams({
      saved_within: '7d',
      tz: zone,
    }).toString(),
  )
  await vi.waitFor(() =>
    expect(el.querySelector('h1')!.textContent).toBe('本周'),
  )
  expect(el.querySelector('.folder-status')).toBeNull()
})

it('follows a tag merged away in the open folder, still unmodified', async () => {
  const from = '00000000-0000-7000-8000-0000000000a1'
  const into = '00000000-0000-7000-8000-0000000000b1'
  folders = [folder({ filter: `tag=${from}` })]
  let tags = [
    { id: from, name: '甲' },
    { id: into, name: '乙' },
  ]
  let merged = false
  const base = api.getMockImplementation()!
  api.mockImplementation((path, request) => {
    if (path === '/tags') return tags
    // The folders' reload is slow: the address already names the new tag.
    if (path === '/folders' && merged) return new Promise(() => {})
    if (path === `/tags/${from}`) {
      merged = true
      // The server moves the folder along with the tag.
      tags = tags.filter((t) => t.id !== from)
      folders = folders.map((f) => ({
        ...f,
        filter: f.filter?.replace(from, into) ?? null,
      }))
      return { tag: tags[0], merged: true, moved: 1 }
    }
    return base(path, request)
  })
  const el = await mount(`/folder/${FOLDER}`)
  await vi.waitFor(() => expect(router.currentRoute.value.query.tag).toBe(from))
  await vi.waitFor(() => expect(button(el, '编辑')).toBeDefined())
  button(el, '编辑').click()
  await nextTick()
  el.querySelector<HTMLButtonElement>('[aria-label="编辑标签「甲」"]')!.click()
  await nextTick()
  const input = el.querySelector<HTMLInputElement>('dialog[open] input')!
  input.value = '乙'
  input.dispatchEvent(new Event('input'))
  await nextTick()
  input.form!.requestSubmit()
  const merge = await vi.waitFor(() => {
    const found = [
      ...el.querySelectorAll<HTMLButtonElement>('dialog[open] button'),
    ].find((b) => b.textContent?.trim() === '合并')
    expect(found).toBeDefined()
    return found!
  })
  merge.click()
  await vi.waitFor(() => expect(router.currentRoute.value.query.tag).toBe(into))
  await vi.waitFor(() => expect(listQueries().at(-1)?.get('tag')).toBe(into))
  expect(el.querySelector('.folder-status')).toBeNull()
  expect(sent('PATCH', `/folders/${FOLDER}`)).toEqual([])
})
