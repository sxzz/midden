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
  created_at: '2026-11-01T00:00:00.000Z',
  updated_at: '2026-11-01T00:00:00.000Z',
  ...fields,
})

let folders: Folder[] = []
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
    }),
  ]
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

it('lists the tab’s folders and saves the current filters as one', async () => {
  const el = await mount('/?media_type=video')
  await vi.waitFor(() =>
    expect(el.querySelector('nav[aria-label="收藏夹"]')?.textContent).toBe(
      '图片3',
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
