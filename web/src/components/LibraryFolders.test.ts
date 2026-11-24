import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp, nextTick, vaporInteropPlugin } from 'vue'
import { router } from '../router'
import { mockApi, type Request } from '../testing/api'
import CollectionLibrary from './CollectionLibrary.vue'
import type { Folder } from '../api'

const FOLDER = '00000000-0000-7000-8000-00000000000f'
const folder = (fields: Partial<Folder>): Folder => ({
  id: FOLDER,
  name: '图片',
  filter: 'entity_type=x.post%2Cinstagram.post&media_type=image',
  count: 3,
  types: { 'x.post': 3 },
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
      filter: 'entity_type=x.profile%2Cinstagram.profile&visibility=private',
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
    if (path.startsWith('/collections/count?'))
      return {
        count: Object.values(counts).reduce((a, b) => a + b, 0),
        types: counts,
      }
    if (path.startsWith('/collections?')) return { items: [] }
    if (path === '/tags') return []
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
  expect(sent('POST', '/folders')).toEqual([
    {
      name: '视频',
      filter: 'entity_type=x.post%2Cinstagram.post&media_type=video',
    },
  ])
  await vi.waitFor(() =>
    expect(el.querySelector('h1')!.textContent).toBe('视频'),
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

  await router.push(
    `/folder/${FOLDER}?entity_type=x.post,instagram.post&media_type=image&order=asc`,
  )
  await vi.waitFor(() =>
    expect(el.querySelector('.folder-status')?.textContent).toContain(
      '筛选条件已修改',
    ),
  )
  button(el, '更新收藏夹').click()
  await vi.waitFor(() => expect(el.querySelector('.folder-status')).toBeNull())
  expect(sent('PATCH', `/folders/${FOLDER}`)).toEqual([
    {
      filter: 'entity_type=x.post%2Cinstagram.post&media_type=image&order=asc',
    },
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
  expect(api.mock.calls.some(([p]) => p.startsWith('/collections/count'))).toBe(
    false,
  )

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
  // Another tab is not another filter.
  expect(el.querySelector('.folder-status')).toBeNull()
  // The filters offer the kind as one of the folder's own conditions.
  expect(el.querySelector('select[aria-label="类型"]')).not.toBeNull()

  // A changed filter asks for its own counts: only accounts are left.
  counts = { 'x.profile': 1 }
  await router.push(`/folder/${MIXED}?visibility=public&tab=post`)
  await vi.waitFor(() => expect(tabs(el)).toEqual([]))
  await vi.waitFor(() =>
    expect(listQueries().at(-1)?.get('entity_type')).toBe(
      'x.profile,instagram.profile',
    ),
  )
  expect(
    api.mock.calls.filter(([p]) => p.startsWith('/collections/count')),
  ).toHaveLength(1)
  expect(el.querySelector('.folder-status')?.textContent).toContain(
    '筛选条件已修改',
  )
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
    '最近 7 天',
    '最近 30 天',
    '自定义',
  ])
  range.value = '7d'
  range.dispatchEvent(new Event('change'))
  await vi.waitFor(() =>
    expect(listQueries().at(-1)?.get('saved_within')).toBe('7d'),
  )
  expect(listQueries().at(-1)?.get('time_zone')).toBe(zone)
  expect(listQueries().at(-1)?.has('saved_from')).toBe(false)
  expect(router.currentRoute.value.query.saved_within).toBe('7d')
  await vi.waitFor(() =>
    expect(el.querySelector('.filter-summary')?.textContent).toBe('最近 7 天'),
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
      entity_type: 'x.post,instagram.post',
      saved_within: '7d',
      time_zone: zone,
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
  folders = [
    folder({ filter: `entity_type=x.post%2Cinstagram.post&tag=${from}` }),
  ]
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
        filter: f.filter.replace(from, into),
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
