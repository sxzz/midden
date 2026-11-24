import { afterEach, expect, it, vi } from 'vitest'
import { createVaporApp } from 'vue'
import { mockApi } from '../testing/api'
import CaptureRecordDetail from './CaptureRecordDetail.vue'
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))

let unmount = () => {}
afterEach(() => {
  unmount()
  document.body.replaceChildren()
  vi.resetAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const detail = (members: Record<string, number | boolean>) => ({
  id: 'record',
  job_id: 'job',
  collection_id: 'profile',
  saved: true,
  url: 'https://x.com/fixture',
  input: 'https://x.com/fixture',
  platform: 'x',
  kind: 'profile',
  state: 'complete',
  media: { total: 0, ready: 0, failed: 0 },
  created_at: '2026-10-14T08:00:00Z',
  done: true,
  members: { total: 3, pending: 0, done: true, ...members },
  warnings: [],
  media_items: [],
  reasons: [],
})
const member = (id: string, state = 'complete') => ({
  job_id: id,
  collection_id: id,
  saved: true,
  url: `https://x.com/fixture/status/${id}`,
  state,
  reasons: [],
  gone: false,
  created_at: '2026-10-14T08:00:01Z',
})

/** Mount a record whose members are listed by state filter. */
function mount(
  record: () => ReturnType<typeof detail>,
  lists: Record<string, ReturnType<typeof member>[]>,
) {
  const queried: string[] = []
  mockApi((path) => {
    const url = new URL(path, 'http://localhost')
    if (url.pathname === '/captures/record') return record()
    if (url.pathname === '/captures/record/members') {
      const state = url.searchParams.get('state') ?? ''
      queried.push(state)
      return { items: lists[state] ?? [] }
    }
    throw new Error(`unexpected ${path}`)
  })
  const el = document.createElement('div')
  document.body.append(el)
  const app = createVaporApp(CaptureRecordDetail, { id: 'record' })
  app.mount(el)
  unmount = () => app.unmount()
  const tabs = () =>
    [...el.querySelectorAll('[role=tab]')].map((tab) => ({
      name: tab.textContent!.trim(),
      selected: tab.getAttribute('aria-selected') === 'true',
    }))
  const click = (name: string) =>
    [...el.querySelectorAll<HTMLElement>('[role=tab]')]
      .find((tab) => tab.textContent!.startsWith(name))!
      .click()
  return { el, queried, tabs, click }
}

it('splits posts into new, updated and failed ones, with counts', async () => {
  const { el, queried, tabs, click } = mount(
    () => detail({ complete: 2, partial: 0, failed: 1, added: 0, updated: 2 }),
    {
      updated: [member('1'), member('2')],
      problem: [member('3', 'failed')],
    },
  )
  // Nothing is new, so the first tab with posts opens.
  await vi.waitFor(() => expect(el.textContent).toContain('status/1'))
  expect(tabs()).toEqual([
    { name: '新增记录 0', selected: false },
    { name: '更新记录 2', selected: true },
    { name: '异常记录 1', selected: false },
  ])
  click('异常记录')
  await vi.waitFor(() => expect(el.textContent).toContain('status/3'))
  expect(el.textContent).not.toContain('status/1')
  click('新增记录')
  await vi.waitFor(() => expect(el.textContent).toContain('没有新增的帖子。'))
  // A tab seen before shows again without loading.
  click('更新记录')
  await vi.waitFor(() => expect(el.textContent).toContain('status/2'))
  expect(queried).toEqual(['updated', 'problem', 'added'])
})

it('lists running posts until they finish, then leaves their tab', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const running = {
    ...detail({ complete: 1, partial: 0, failed: 0, added: 1, updated: 0 }),
    done: false,
  }
  running.members = { ...running.members, pending: 2, done: false }
  const record = { current: running }
  const { el, queried, tabs } = mount(() => record.current, {
    added: [member('1')],
    pending: [member('2', 'downloading'), member('3', 'queued')],
  })
  await vi.waitFor(() => expect(el.textContent).toContain('status/1'))
  expect(tabs()).toEqual([
    { name: '新增记录 1', selected: true },
    { name: '更新记录 0', selected: false },
    { name: '异常记录 0', selected: false },
    { name: '正在采集 2', selected: false },
  ])
  ;[...el.querySelectorAll<HTMLElement>('[role=tab]')].at(-1)!.click()
  await vi.waitFor(() => expect(el.textContent).toContain('status/3'))

  // Both finish as new posts: the tab goes and the list shows them there.
  record.current = detail({
    complete: 3,
    partial: 0,
    failed: 0,
    added: 3,
    updated: 0,
  })
  await vi.advanceTimersByTimeAsync(2500)
  await vi.waitFor(() =>
    expect(tabs()).toEqual([
      { name: '新增记录 3', selected: true },
      { name: '更新记录 0', selected: false },
      { name: '异常记录 0', selected: false },
    ]),
  )
  expect(queried).toEqual(['added', 'pending', 'added'])
  vi.useRealTimers()
})

it('lists every post of a record from before new and updated were told apart', async () => {
  const { el, queried, tabs } = mount(
    () => detail({ complete: 2, partial: 1, failed: 0 }),
    { '': [member('1'), member('2'), member('3', 'partial')] },
  )
  await vi.waitFor(() => expect(el.textContent).toContain('status/3'))
  expect(tabs()).toEqual([
    { name: '全部 3', selected: true },
    { name: '异常记录 1', selected: false },
  ])
  expect(queried).toEqual([''])
})
