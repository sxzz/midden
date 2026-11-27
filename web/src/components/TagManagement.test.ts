import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp, nextTick, vaporInteropPlugin } from 'vue'
import { APIError, type Tag } from '../api'
import { mockApi, type Request } from '../testing/api'
import CollectionFilters from './CollectionFilters.vue'

let tags: Tag[] = []
let api: ReturnType<typeof mockApi>
/** Answers to the tag writes, by method; the default is what the server does. */
let refuse: APIError | undefined
let unmount = () => {}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.open = true
  })
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.open = false
  })
  tags = [
    { id: 'a', name: '甲' },
    { id: 'b', name: '乙' },
  ]
  refuse = undefined
  api = mockApi((path, request: Request) => {
    if (path === '/tags') return tags
    if (path.startsWith('/collections/count?'))
      return {
        count:
          new URLSearchParams(path.split('?', 2)[1]).get('tag') === 'a' ? 3 : 0,
        types: {},
      }
    if (path.startsWith('/tags/')) {
      if (refuse) throw refuse
      const id = path.slice('/tags/'.length)
      if (request.method === 'DELETE') {
        tags = tags.filter((t) => t.id !== id)
        return
      }
      const { name } = JSON.parse(request.body!) as { name: string }
      const into = tags.find((t) => t.name === name && t.id !== id)
      if (into) {
        tags = tags.filter((t) => t.id !== id)
        return { tag: into, merged: true, moved: 3 }
      }
      tags = tags.map((t) => (t.id === id ? { id, name } : t))
      return { tag: { id, name }, merged: false, moved: 0 }
    }
    return { items: [] }
  })
})
afterEach(() => {
  unmount()
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function mount(query: string) {
  const search = vi.fn()
  const changed = vi.fn()
  const el = document.createElement('div')
  document.body.append(el)
  const app = createApp(CollectionFilters, {
    query,
    onSearch: search,
    onTagsChanged: changed,
  }).use(vaporInteropPlugin)
  app.mount(el)
  unmount = () => app.unmount()
  await vi.waitFor(() => expect(el.textContent).toContain('甲'))
  return { el, search, changed }
}
const button = (el: HTMLElement, text: string) => {
  const found = [...el.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === text,
  )
  if (!found) throw new Error(`no button reading “${text}”`)
  return found
}
/** The buttons of whichever sheet is open on top. */
const sheet = () => [...document.querySelectorAll('dialog[open]')].at(-1)!
async function edit(el: HTMLElement, tag: string) {
  button(el, '编辑').click()
  await nextTick()
  el.querySelector<HTMLButtonElement>(
    `button[aria-label="编辑标签「${CSS.escape(tag)}」"]`,
  )!.click()
  await nextTick()
}
async function rename(name: string) {
  const input = sheet().querySelector('input')!
  input.value = name
  input.dispatchEvent(new Event('input'))
  await nextTick()
  input.form!.requestSubmit()
}
const writes = () =>
  api.mock.calls
    .filter(([path, r]) => path.startsWith('/tags/') && r.method !== 'GET')
    .map(([path, r]) => [r.method, path, r.body && JSON.parse(r.body)])

it('renames a tag in place, the filter on it unchanged', async () => {
  const { el, search, changed } = await mount('tag=a')
  expect(el.querySelector('.filter-summary')?.textContent).toBe('甲')
  // The sheets stay out of lists until tags are being edited.
  expect(document.querySelector('dialog')).toBeNull()
  await edit(el, '甲')
  expect(sheet().querySelector('input')!.value).toBe('甲')
  await rename(' 丙 ')
  await vi.waitFor(() =>
    expect(el.querySelector('.filter-summary')?.textContent).toBe('丙'),
  )
  expect(writes()).toEqual([['PATCH', '/tags/a', { name: '丙' }]])
  expect(changed).toHaveBeenCalledWith({
    from: 'a',
    to: { id: 'a', name: '丙' },
  })
  expect(search).not.toHaveBeenCalled()
  expect(document.querySelector('dialog[open]')).toBeNull()
  // Editing stays on until it is done; picking is back after.
  expect(el.querySelector('[aria-label="编辑标签「丙」"]')).not.toBeNull()
  button(el, '完成').click()
  await nextTick()
  expect(el.querySelector('[aria-label="标签筛选"]')?.textContent).toContain(
    '丙',
  )
})

it('asks before merging into a tag that has the name, then follows it', async () => {
  const { el, search, changed } = await mount('tag=a&q=x')
  await edit(el, '甲')
  await rename('乙')
  await vi.waitFor(() =>
    expect(sheet().textContent).toContain('已有标签「乙」，将合并3条收藏'),
  )
  expect(writes()).toEqual([])
  // Backing out returns to the name, still unsaved.
  button(sheet() as HTMLElement, '取消').click()
  await nextTick()
  expect(sheet().querySelector('input')!.value).toBe('乙')
  await rename('乙')
  await vi.waitFor(() => expect(sheet().textContent).toContain('将合并'))
  button(sheet() as HTMLElement, '合并').click()
  await vi.waitFor(() => expect(search).toHaveBeenCalled())
  expect(writes()).toEqual([['PATCH', '/tags/a', { name: '乙' }]])
  expect(changed).toHaveBeenCalledWith({
    from: 'a',
    to: { id: 'b', name: '乙' },
  })
  const query = new URLSearchParams(search.mock.calls.at(-1)![0])
  expect(query.get('tag')).toBe('b')
  expect(query.get('q')).toBe('x')
  expect(el.querySelector('.filter-summary')?.textContent).toBe('乙')
  expect(el.querySelector('[aria-label="编辑标签「甲」"]')).toBeNull()
})

it('asks before deleting a tag and drops the filter on it', async () => {
  const { el, search, changed } = await mount('tag=a')
  await edit(el, '甲')
  button(sheet() as HTMLElement, '删除标签').click()
  await vi.waitFor(() =>
    expect(sheet().textContent).toContain('删除标签「甲」？'),
  )
  expect(sheet().textContent).toContain('将从3条收藏上移除')
  button(sheet() as HTMLElement, '删除标签').click()
  await vi.waitFor(() => expect(search).toHaveBeenCalledWith(''))
  expect(writes()).toEqual([['DELETE', '/tags/a', undefined]])
  expect(changed).toHaveBeenCalledWith({ from: 'a' })
  expect(el.querySelector('[aria-label="编辑标签「甲」"]')).toBeNull()
})

it('says nothing about a count a tag does not have', async () => {
  const { el } = await mount('')
  await edit(el, '乙')
  button(sheet() as HTMLElement, '删除标签').click()
  await vi.waitFor(() =>
    expect(sheet().textContent).toContain('删除标签「乙」？'),
  )
  expect(sheet().textContent).not.toContain('条收藏')
})

it('shows why the server refused, back on the name', async () => {
  refuse = new APIError(503, '服务暂时不可用')
  const { el, search } = await mount('tag=a')
  await edit(el, '甲')
  button(sheet() as HTMLElement, '删除标签').click()
  await vi.waitFor(() =>
    expect(sheet().textContent).toContain('删除标签「甲」？'),
  )
  button(sheet() as HTMLElement, '删除标签').click()
  await vi.waitFor(() =>
    expect(sheet().querySelector('[role="alert"]')?.textContent).toBe(
      '服务暂时不可用',
    ),
  )
  expect(sheet().querySelector('input')).not.toBeNull()
  expect(search).not.toHaveBeenCalled()
})

const last = (search: ReturnType<typeof vi.fn>) =>
  Object.fromEntries(new URLSearchParams(search.mock.calls.at(-1)![0]))

it('wants several tags, any or all of them, and excludes some', async () => {
  const { el, search } = await mount('')
  const chip = (name: string) =>
    el.querySelector<HTMLButtonElement>(
      `button[aria-label^="${CSS.escape(name)}："]`,
    )!
  const summary = () => el.querySelector('.filter-summary')?.textContent
  const mode = () => el.querySelector('[aria-label="标签匹配方式"]')
  chip('甲').click()
  await vi.waitFor(() => expect(last(search)).toEqual({ tag: 'a' }))
  expect(mode()).toBeNull()
  chip('乙').click()
  await vi.waitFor(() => expect(last(search)).toEqual({ tag: 'a,b' }))
  expect(summary()).toBe('甲、乙')
  expect(chip('乙').getAttribute('aria-label')).toBe('乙：包含')
  // Two wanted tags offer how they combine.
  const all = mode()!.querySelector<HTMLInputElement>('input[value="all"]')!
  all.click()
  await vi.waitFor(() =>
    expect(last(search)).toEqual({ tag: 'a,b', tag_mode: 'all' }),
  )
  expect(summary()).toBe('甲 且 乙')
  // A second tap excludes the tag, which reads as such.
  chip('乙').click()
  await vi.waitFor(() =>
    expect(last(search)).toEqual({ tag: 'a', not_tag: 'b' }),
  )
  expect(chip('乙').textContent?.trim()).toBe('非 乙')
  expect(chip('乙').getAttribute('aria-label')).toBe('乙：排除')
  expect(summary()).toBe('甲、非 乙')
  expect(mode()).toBeNull()
  // A third lets it go; “全部” lets every tag go.
  chip('乙').click()
  await vi.waitFor(() => expect(last(search)).toEqual({ tag: 'a' }))
  chip('乙').click()
  chip('乙').click()
  await vi.waitFor(() =>
    expect(last(search)).toEqual({ tag: 'a', not_tag: 'b' }),
  )
  button(el.querySelector('[aria-label="标签筛选"]')!, '全部').click()
  await vi.waitFor(() => expect(search).toHaveBeenLastCalledWith(''))
})

it('reads tag lists from the address in either order', async () => {
  const { el, search } = await mount('tag=b,a&tag_mode=all')
  expect(el.querySelector('.filter-summary')?.textContent).toBe('乙 且 甲')
  expect(
    el.querySelector<HTMLInputElement>('input[value="all"]')!.checked,
  ).toBe(true)
  expect(search).not.toHaveBeenCalled()
})

it('merges a wanted tag into another wanted one', async () => {
  const { el, search } = await mount('tag=a,b&tag_mode=all')
  await edit(el, '甲')
  await rename('乙')
  await vi.waitFor(() => expect(sheet().textContent).toContain('将合并'))
  button(sheet() as HTMLElement, '合并').click()
  // One tag left: how tags combine no longer applies.
  await vi.waitFor(() => expect(last(search)).toEqual({ tag: 'b' }))
})

it('deletes an excluded tag out of the filter', async () => {
  const { el, search } = await mount('tag=b&not_tag=a')
  await edit(el, '甲')
  button(sheet() as HTMLElement, '删除标签').click()
  await vi.waitFor(() =>
    expect(sheet().textContent).toContain('删除标签「甲」'),
  )
  button(sheet() as HTMLElement, '删除标签').click()
  await vi.waitFor(() => expect(last(search)).toEqual({ tag: 'b' }))
})
