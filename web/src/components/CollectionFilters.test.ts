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
async function searchFor(el: HTMLElement, q: string) {
  const input = el.querySelector<HTMLInputElement>(
    'input[aria-label="搜索正文或作者"]',
  )!
  input.value = q
  input.dispatchEvent(new Event('input', { bubbles: true }))
  el.querySelector('form')!.dispatchEvent(
    new Event('submit', { bubbles: true, cancelable: true }),
  )
  await nextTick()
}

it('orders a search by relevance, and by the chosen order within it', async () => {
  const { el, search } = await mount('')
  expect(options(el, '排序')).not.toContain('相关度')
  expect(select(el, '排序').value).toBe('published')

  await searchFor(el, 'cat')
  expect(search).toHaveBeenLastCalledWith('q=cat')
  expect(options(el, '排序')[0]).toBe('相关度')
  expect(select(el, '排序').value).toBe('relevance')
  // Relevance has no direction to pick.
  expect(el.querySelector('select[aria-label="排序方向"]')).toBeNull()

  await choose(el, '排序', 'published')
  expect(search).toHaveBeenLastCalledWith('q=cat&sort=published')
  expect(options(el, '排序方向')).toEqual(['从新到旧', '从旧到新'])
  await choose(el, '排序', 'relevance')
  expect(search).toHaveBeenLastCalledWith('q=cat')

  // Ending the search ends relevance: the list's own default returns.
  await searchFor(el, '')
  expect(search).toHaveBeenLastCalledWith('')
  expect(options(el, '排序')).not.toContain('相关度')
  expect(select(el, '排序').value).toBe('published')
  unmount()

  // An order chosen before a search is kept by it.
  const chosen = await mount('sort=updated')
  await searchFor(chosen.el, 'cat')
  expect(chosen.search).toHaveBeenLastCalledWith('q=cat&sort=updated')
  expect(select(chosen.el, '排序').value).toBe('updated')
})

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

it('filters deleted posts and suspended accounts, behind a share too', async () => {
  const posts = await mount('')
  expect(options(posts.el, '原站状态')).toEqual([
    '全部',
    '原站已删除的帖子',
    '作者被封禁的帖子',
  ])
  await choose(posts.el, '原站状态', 'deleted')
  expect(posts.search).toHaveBeenLastCalledWith('source_state=deleted')
  unmount()

  const accounts = await mount(ACCOUNTS)
  expect(options(accounts.el, '原站状态')).toEqual([
    '全部',
    '被封禁的账号',
    '已不存在的账号',
  ])
  await choose(accounts.el, '原站状态', 'suspended')
  expect(accounts.search).toHaveBeenLastCalledWith(
    `source_state=suspended&${ACCOUNTS}`,
  )
  unmount()

  // Public on the platform, so a visitor can ask for it.
  shareSlug.value = 's'
  const shared = await mount('source_state=deleted')
  expect(select(shared.el, '原站状态').value).toBe('deleted')
})
