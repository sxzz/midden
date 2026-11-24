import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp, nextTick, vaporInteropPlugin } from 'vue'
import { shareSlug } from '../share'
import { mockApi } from '../testing/api'
import CollectionFilters from './CollectionFilters.vue'

let unmount = () => {}
beforeEach(() => {
  mockApi((path) => (path === '/tags' ? [] : { items: [] }))
})
afterEach(() => {
  unmount()
  document.body.replaceChildren()
  shareSlug.value = ''
  vi.unstubAllGlobals()
})

async function mount(query: string, props: { folder?: boolean } = {}) {
  const search = vi.fn()
  const el = document.createElement('div')
  document.body.append(el)
  const app = createApp(CollectionFilters, {
    query,
    onSearch: search,
    ...props,
  }).use(vaporInteropPlugin)
  app.mount(el)
  unmount = () => app.unmount()
  await nextTick()
  return { el, search }
}
const select = (el: HTMLElement, label: string) =>
  el.querySelector<HTMLSelectElement>(
    `select[aria-label="${CSS.escape(label)}"]`,
  )!
const options = (el: HTMLElement, label: string) =>
  [...select(el, label).options].map((option) => option.textContent?.trim())
async function choose(el: HTMLElement, label: string, value: string) {
  const picker = select(el, label)
  picker.value = value
  picker.dispatchEvent(new Event('change', { bubbles: true }))
  await nextTick()
}
const ACCOUNTS = 'entity_type=x.profile%2Cinstagram.profile'

it('offers the count orders on the accounts tab only', async () => {
  const posts = await mount('')
  expect(options(posts.el, '排序')).toEqual([
    '发帖时间',
    '添加时间',
    '更新时间',
    '存储空间',
  ])
  unmount()

  const { el, search } = await mount(ACCOUNTS)
  expect(options(el, '排序')).toEqual([
    '添加时间',
    '更新时间',
    '存储空间',
    '粉丝数',
    '关注数',
  ])
  await choose(el, '排序', 'followers')
  expect(search).toHaveBeenLastCalledWith(`sort=followers&${ACCOUNTS}`)
  expect(options(el, '排序方向')).toEqual(['从多到少', '从少到多'])
  await choose(el, '排序方向', 'asc')
  expect(search).toHaveBeenLastCalledWith(
    `sort=followers&order=asc&${ACCOUNTS}`,
  )
  await choose(el, '排序', 'following')
  expect(search).toHaveBeenLastCalledWith(
    `sort=following&order=asc&${ACCOUNTS}`,
  )
  await choose(el, '排序', 'storage')
  expect(options(el, '排序方向')).toEqual(['从大到小', '从小到大'])
  await choose(el, '排序', 'updated')
  expect(options(el, '排序方向')).toEqual(['从新到旧', '从旧到新'])
})

it("reads a folder's count order as the update time on its posts tab", async () => {
  const { el } = await mount('tab=post&sort=followers', { folder: true })
  expect(select(el, '排序').value).toBe('updated')
  unmount()
  const accounts = await mount('tab=profile&sort=followers', { folder: true })
  expect(select(accounts.el, '排序').value).toBe('followers')
})

it('offers the count orders behind a public link too', async () => {
  shareSlug.value = 'slug'
  const { el } = await mount(`sort=following&${ACCOUNTS}`)
  expect(options(el, '排序')).toEqual(['更新时间', '粉丝数', '关注数'])
  expect(select(el, '排序').value).toBe('following')
})
