import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp, createVaporApp, nextTick, vaporInteropPlugin } from 'vue'
import { router } from '../router'
import { collection, mockApi, type Request } from '../testing/api'
import CollectionLibrary from './CollectionLibrary.vue'
import DeleteSheet from './DeleteSheet.vue'
import type { DeleteCounts } from '../deletion'

const items = [1, 2, 3].map((n) =>
  collection({
    id: `0000000${n}-0000-7000-8000-000000000000`,
    text: `第 ${n} 条`,
    author_name: `作者${n}`,
  }),
)
let listed = items
let counts: DeleteCounts
let api: ReturnType<typeof mockApi>
/** What was asked of the deletion, `preview` marking its dry runs. */
const deletes = () =>
  api.mock.calls
    .filter(([path]) => path.startsWith('/collections/delete'))
    .map(([path, request]) => ({
      ...JSON.parse((request as Request).body!),
      preview: path === '/collections/delete/preview',
    }))

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
  listed = items
  counts = {
    profiles: 1,
    posts: 1,
    related: 40,
    kept: { listed: 2, saved: 1, annotated: 0, quoted: 0 },
  }
  api = mockApi((path, request) => {
    if (path === '/collections/delete/preview') return counts
    if (path === '/collections/delete') {
      const body = JSON.parse(request.body!)
      listed = listed.filter((item) => !body.ids.includes(item.id))
      return counts
    }
    if (path.startsWith('/collections?')) return { items: listed }
    if (path.startsWith('/collections/count')) return { count: 0, types: {} }
    if (path === '/folders' || path === '/tags') return []
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

const button = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === text,
  )

it('多选 shows a bar to update or delete the selection', async () => {
  location.hash = '/'
  await router.push('/')
  const el = document.createElement('div')
  document.body.append(el)
  const app = createApp(CollectionLibrary).use(vaporInteropPlugin).use(router)
  await router.isReady()
  app.mount(el)
  unmount = () => app.unmount()
  await vi.waitFor(() => expect(el.textContent).toContain('第 3 条'))

  button(el, '多选')!.click()
  await nextTick()
  const bar = el.querySelector<HTMLElement>('[aria-label="多选"]')!
  const more = bar.querySelector<HTMLButtonElement>('[aria-label="更多操作"]')!
  expect(more.disabled).toBe(true)
  expect(button(bar, '更新')!.disabled).toBe(true)
  const rows = [...el.querySelectorAll<HTMLElement>('[role="checkbox"]')]
  rows[0]!.click()
  rows[2]!.click()
  await nextTick()
  expect(bar.textContent).toContain('已选 2 项')
  expect(button(bar, '更新')!.disabled).toBe(false)
  expect(more.disabled).toBe(false)

  // The removals sit in the ⋯ menu, which hands over to their confirmation.
  more.click()
  await nextTick()
  const menu = el.querySelector<HTMLDialogElement>('dialog[open]')!
  expect(button(menu, '删除媒体')).toBeDefined()
  button(menu, '删除')!.click()
  await nextTick()
  expect(menu.open).toBe(false)
  const sheet = () => el.querySelector<HTMLElement>('dialog[open]')
  await vi.waitFor(() =>
    expect(sheet()?.textContent).toContain('将删除 1 个账号、1 条帖子'),
  )
  expect(sheet()!.textContent).toContain('删除 2 项收藏？')
  // Counted once with the accounts' posts, which are not deleted by default.
  const option = sheet()!.querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  )!
  expect(option.checked).toBe(false)
  option.click()
  await nextTick()
  expect(sheet()!.textContent).toContain(
    '将删除 1 个账号、41 条帖子（保留 3 条：其他账号也关联 2 条、单独收藏 1 条）',
  )
  button(sheet()!, '删除')!.click()
  await vi.waitFor(() => expect(el.textContent).not.toContain('第 3 条'))
  expect(deletes()).toEqual([
    { ids: [items[0]!.id, items[2]!.id], with_posts: true, preview: true },
    { ids: [items[0]!.id, items[2]!.id], with_posts: true, preview: false },
  ])
  expect(el.textContent).toContain('第 2 条')
  expect(el.querySelector('[aria-label="多选"]')).toBeNull()
  expect(el.querySelectorAll('[role="checkbox"]')).toHaveLength(0)
})

it('a single post offers no option for posts', async () => {
  counts = { ...counts, profiles: 0, related: 0 }
  const el = document.createElement('div')
  document.body.append(el)
  const deleted: boolean[] = []
  const app = createVaporApp(DeleteSheet, {
    open: () => true,
    ids: () => [items[1]!.id],
    title: () => '删除这条收藏？',
    onDeleted: () => (withPosts: boolean) => deleted.push(withPosts),
  })
  app.mount(el)
  unmount = () => app.unmount()
  await vi.waitFor(() => expect(el.textContent).toContain('将删除 1 条帖子'))
  expect(el.querySelector('input[type="checkbox"]')).toBeNull()
  button(el, '删除')!.click()
  await vi.waitFor(() => expect(deleted).toEqual([false]))
  expect(deletes().at(-1)).toEqual({
    ids: [items[1]!.id],
    with_posts: false,
    preview: false,
  })
})
