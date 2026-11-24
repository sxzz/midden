import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp, nextTick, vaporInteropPlugin } from 'vue'
import { shareSlug } from '../share'
import { mockApi } from '../testing/api'
import CollectionFilters from './CollectionFilters.vue'
import type { Perspective } from '../api'

const OWNER = 'x/x.profile/100'
const FRIEND = 'x/x.profile/200'
const accounts: Perspective[] = [
  {
    id: OWNER,
    name: '我',
    username: 'owner',
    own: true,
    following: { complete_at: '2026-11-20T04:00:00.000Z' },
    followers: {},
  },
  {
    id: FRIEND,
    name: '朋友',
    username: 'friend',
    following: {},
    followers: { partial_at: '2026-11-21T04:00:00.000Z' },
  },
]
let api: ReturnType<typeof mockApi>
let unmount = () => {}

beforeEach(() => {
  api = mockApi((path) => {
    if (path === '/tags') return []
    if (path.startsWith('/collections/perspectives')) {
      const q = new URLSearchParams(path.split('?', 2)[1])
      const key = q.get('rel_of')
      return {
        items: key
          ? accounts.filter((item) => item.id === key)
          : accounts.filter((item) =>
              (item.username ?? '').includes(q.get('q') ?? ''),
            ),
      }
    }
    return { items: [] }
  })
})
afterEach(() => {
  unmount()
  document.body.replaceChildren()
  shareSlug.value = ''
  vi.unstubAllGlobals()
})

async function mount(query: string) {
  const search = vi.fn()
  const el = document.createElement('div')
  document.body.append(el)
  const app = createApp(CollectionFilters, { query, onSearch: search }).use(
    vaporInteropPlugin,
  )
  app.mount(el)
  unmount = () => app.unmount()
  await nextTick()
  return { el, search }
}
const summary = (el: HTMLElement) =>
  el.querySelector('.filter-summary')?.textContent
const lastQuery = (search: ReturnType<typeof vi.fn>) =>
  new URLSearchParams(search.mock.lastCall?.[0] as string)
const perspectiveCalls = () =>
  api.mock.calls.filter(([path]) =>
    path.startsWith('/collections/perspectives'),
  )

it('reads a filter from the address by handle, with its note', async () => {
  const { el } = await mount(
    `rel_of=${encodeURIComponent(OWNER)}&rel=followers&entity_type=x.profile,instagram.profile`,
  )
  await vi.waitFor(() => expect(summary(el)).toBe('关注 @owner 的'))
  // Only the chosen account is looked up until the list is opened.
  expect(perspectiveCalls().map(([path]) => path)).toEqual([
    `/collections/perspectives?rel_of=${encodeURIComponent(OWNER)}`,
  ])
  const mode = el.querySelector('[role=radiogroup][aria-label="关系方向"]')!
  expect(
    [...mode.querySelectorAll('label')].map((label) => label.textContent),
  ).toEqual(['他关注的', '关注他的', '互关'])
  expect(mode.querySelector<HTMLInputElement>('input:checked')!.value).toBe(
    'followers',
  )
  expect(el.querySelector('.relation .note')?.textContent).toBe(
    '粉丝名单未抓取',
  )
})

it('picks one account, then a mode, and lets both go together', async () => {
  const { el, search } = await mount('')
  expect(el.querySelector('[aria-label="关系方向"]')).toBeNull()
  const picker = el.querySelector<HTMLDetailsElement>('details.multi-select')!
  expect(picker.querySelector('summary')!.textContent).toContain('关系')
  picker.open = true
  picker.dispatchEvent(new Event('toggle'))
  await vi.waitFor(() =>
    expect(picker.querySelectorAll('[role=option]')).toHaveLength(2),
  )
  // Name first, the handle beside it; the list picks one at a time.
  const options = [
    ...picker.querySelectorAll<HTMLButtonElement>('[role=option]'),
  ]
  expect(options.map((o) => o.textContent)).toEqual([
    '我 @owner',
    '朋友 @friend',
  ])
  expect(
    picker
      .querySelector('[role=listbox]')!
      .getAttribute('aria-multiselectable'),
  ).toBe('false')
  options[1]!.click()
  await vi.waitFor(() => expect(lastQuery(search).get('rel_of')).toBe(FRIEND))
  expect(lastQuery(search).get('rel')).toBe('following')
  expect(picker.open).toBe(false)
  await vi.waitFor(() => expect(summary(el)).toBe('@friend 关注的'))
  expect(el.querySelector('.relation .note')?.textContent).toBe(
    '关注名单未抓取',
  )

  el.querySelector<HTMLInputElement>('input[value=mutual]')!.click()
  await vi.waitFor(() => expect(lastQuery(search).get('rel')).toBe('mutual'))
  expect(summary(el)).toBe('@friend 互关')
  expect(el.querySelector('.relation .note')?.textContent).toMatch(
    /^关注名单未抓取 · 粉丝名单 \d\d-\d\d 部分抓取$/,
  )

  // Picking the same account again lets the filter go.
  picker.open = true
  picker.dispatchEvent(new Event('toggle'))
  await nextTick()
  picker.querySelectorAll<HTMLButtonElement>('[role=option]')[1]!.click()
  await vi.waitFor(() => expect(lastQuery(search).has('rel_of')).toBe(false))
  expect(lastQuery(search).has('rel')).toBe(false)
  expect(el.querySelector('[aria-label="关系方向"]')).toBeNull()
})

it('searches accounts on the server', async () => {
  vi.useFakeTimers()
  try {
    const { el } = await mount('')
    const picker = el.querySelector<HTMLDetailsElement>('details.multi-select')!
    picker.open = true
    picker.dispatchEvent(new Event('toggle'))
    const input = picker.querySelector<HTMLInputElement>('input[type=search]')!
    input.value = 'fri'
    input.dispatchEvent(new Event('input'))
    await vi.advanceTimersByTimeAsync(300)
    expect(perspectiveCalls().at(-1)![0]).toBe(
      '/collections/perspectives?q=fri',
    )
  } finally {
    vi.useRealTimers()
  }
})

it('is not offered behind a public link', async () => {
  shareSlug.value = 'slug'
  const { el } = await mount(
    `rel_of=${encodeURIComponent(OWNER)}&rel=following&q=x`,
  )
  await nextTick()
  expect(el.textContent).not.toContain('关系')
  expect(perspectiveCalls()).toEqual([])
  expect(summary(el) ?? '').not.toContain('@owner')
})
