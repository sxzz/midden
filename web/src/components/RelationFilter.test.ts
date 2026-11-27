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
      const keys = q.getAll('rel_of')
      return {
        items: keys.length
          ? accounts.filter((item) => keys.includes(item.id))
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

it('picks accounts, then a mode, and how many of them', async () => {
  const { el, search } = await mount('')
  expect(el.querySelector('[aria-label="关系方向"]')).toBeNull()
  const picker = el.querySelector<HTMLDetailsElement>('details.multi-select')!
  expect(picker.querySelector('summary')!.textContent).toContain('关系')
  picker.open = true
  picker.dispatchEvent(new Event('toggle'))
  await vi.waitFor(() =>
    expect(picker.querySelectorAll('[role=option]')).toHaveLength(2),
  )
  // Name first, the handle beside it; several may be picked.
  const options = () => [
    ...picker.querySelectorAll<HTMLButtonElement>('[role=option]'),
  ]
  expect(options().map((o) => o.textContent)).toEqual([
    '我 @owner',
    '朋友 @friend',
  ])
  expect(
    picker
      .querySelector('[role=listbox]')!
      .getAttribute('aria-multiselectable'),
  ).toBe('true')
  options()[1]!.click()
  await vi.waitFor(() =>
    expect(lastQuery(search).getAll('rel_of')).toEqual([FRIEND]),
  )
  expect(lastQuery(search).get('rel')).toBe('following')
  await vi.waitFor(() => expect(summary(el)).toBe('@friend 关注的'))
  expect(el.querySelector('.relation .note')?.textContent).toBe(
    '关注名单未抓取',
  )
  // One account has no threshold to set.
  expect(el.querySelector('[aria-label="至少几人"]')).toBeNull()

  el.querySelector<HTMLInputElement>('input[value=mutual]')!.click()
  await vi.waitFor(() => expect(lastQuery(search).get('rel')).toBe('mutual'))
  expect(summary(el)).toBe('@friend 互关')
  expect(el.querySelector('.relation .note')?.textContent).toMatch(
    /^关注名单未抓取 · 粉丝名单 \d\d-\d\d 部分抓取$/,
  )

  // A second account: shared by both, by default.
  options()[0]!.click()
  await vi.waitFor(() =>
    expect(lastQuery(search).getAll('rel_of')).toEqual([FRIEND, OWNER]),
  )
  expect(lastQuery(search).has('rel_min')).toBe(false)
  await vi.waitFor(() =>
    expect(summary(el)).toBe('与 @friend、@owner 中至少2人互关'),
  )
  const stepper = el.querySelector('[aria-label="至少几人"]')!
  expect(stepper.textContent).toContain('2')
  expect(
    [...el.querySelectorAll('.relation .note li')].map((li) => li.textContent),
  ).toEqual([
    expect.stringMatching(/^@friend 关注未抓取、粉丝 \d\d-\d\d 部分$/),
    expect.stringMatching(/^@owner 关注 \d\d-\d\d 完整、粉丝未抓取$/),
  ])
  // Two of two is the most.
  expect(
    stepper.querySelector<HTMLButtonElement>('[aria-label="增加"]')!.disabled,
  ).toBe(true)
  stepper.querySelector<HTMLButtonElement>('[aria-label="减少"]')!.click()
  await vi.waitFor(() => expect(lastQuery(search).get('rel_min')).toBe('1'))
  expect(summary(el)).toBe('与 @friend、@owner 中至少1人互关')

  // Letting one go drops the threshold with it.
  options()[0]!.click()
  await vi.waitFor(() =>
    expect(lastQuery(search).getAll('rel_of')).toEqual([FRIEND]),
  )
  expect(lastQuery(search).has('rel_min')).toBe(false)
  // And the last one lets the filter go.
  options()[1]!.click()
  await vi.waitFor(() => expect(lastQuery(search).has('rel_of')).toBe(false))
  expect(lastQuery(search).has('rel')).toBe(false)
  expect(el.querySelector('[aria-label="关系方向"]')).toBeNull()
})

it('reads several accounts and a threshold from the address', async () => {
  const { el } = await mount(
    `rel_of=${encodeURIComponent(OWNER)}&rel_of=${encodeURIComponent(FRIEND)}&rel=following&rel_min=1`,
  )
  await vi.waitFor(() =>
    expect(summary(el)).toBe('@owner、@friend 中至少1人关注的'),
  )
  // Both are looked up at once.
  expect(perspectiveCalls().map(([path]) => path)).toEqual([
    `/collections/perspectives?rel_of=${encodeURIComponent(OWNER)}&rel_of=${encodeURIComponent(FRIEND)}`,
  ])
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
