import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp, h, KeepAlive, nextTick, shallowRef } from 'vue'
import { collection as fixture, mockApi } from '../testing/api'
import { useCollectionDetail } from './useCollectionDetail'
import { toastState } from './useToast'
import type { Collection, HistoryPoint } from '../api'
/** Whether collections answer as a profile rather than a post. */
let profile = false
const collection = (id: string): Collection =>
  fixture({
    id,
    url: 'https://example.test/item',
    text: '合成正文',
    author_name: '合成作者',
    observed_at: '2026-10-01T00:00:00Z',
    revision_id: 'r1',
    ...(profile
      ? {
          graph: {
            root: 'profile',
            relations: [],
            entities: [
              { key: 'profile', type: 'x.profile', external_id: '1', data: {} },
            ],
          },
        }
      : {}),
  })
let api = mockApi()
/** What starting an update answers with: its record. */
const started = { id: 'record-1' }
/** What the collection's update answers with. */
let update: object = { older: false }
/** The history every collection answers with. */
let points: HistoryPoint[] = []
/** The readings every collection's counts answer with. */
let readings: number[] = []
/** How many changes every profile's record answers with. */
let changes = 0
/** What every profile's follows answer with, and how many changes. */
let followCounts: object = {}
let followChanges = 0
/** The kept collection's composable, for tests that step through points. */
let detail: ReturnType<typeof useCollectionDetail> | undefined
/** One shared refresh handle, so the test can start a capture. */
let refresh = async () => {}
/** Collections handed to the library list, to catch writes from a cached view. */
let updates: Collection[] = []
/** Requests held open on purpose, so a later one can overtake them. */
let gates = new Map<string, { wait: Promise<void>; release: () => void }>()
let rejects = new Set<string>()
function hold(path: string) {
  let release = () => {}
  const wait = new Promise<void>((resolve) => {
    release = () => resolve()
  })
  const gate = { wait, release }
  gates.set(path, gate)
  return {
    /** Resolve once the request is in flight, so the hold really applies. */
    reached: () => vi.waitFor(() => expect(gates.has(path)).toBe(false)),
    release: async () => {
      gate.release()
      await vi.advanceTimersByTimeAsync(0)
    },
  }
}
const Detail = {
  props: { id: { type: String, required: true } },
  setup(props: { id: string }) {
    const used = useCollectionDetail(
      () => props.id,
      (value) => updates.push(value),
    )
    if (props.id === 'kept') {
      refresh = () => used.update()
      detail = used
    }
    return () => [h('p', { class: 'error' }, used.error.value)]
  },
}
const shown = shallowRef('kept')
let unmount = () => {}
function mount() {
  const el = document.createElement('div')
  document.body.append(el)
  const app = createApp({
    setup: () => () =>
      h(KeepAlive, { max: 4 }, [
        h(Detail, { key: shown.value, id: shown.value }),
      ]),
  })
  app.mount(el)
  unmount = () => app.unmount()
  return { error: () => el.querySelector('.error')?.textContent }
}
/** Put the shown detail into the cache, or bring a cached one back. */
async function show(id: string) {
  shown.value = id
  await nextTick()
  await vi.advanceTimersByTimeAsync(0)
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('crypto', { randomUUID: () => 'idempotency-key' })
  shown.value = 'kept'
  updates = []
  gates = new Map()
  rejects = new Set()
  points = []
  readings = []
  profile = false
  changes = 0
  followCounts = {}
  followChanges = 0
  detail = undefined
  update = { older: false }
  api = mockApi(async (path) => {
    const gate = gates.get(path)
    if (gate) {
      gates.delete(path)
      await gate.wait
    }
    if (rejects.has(path)) throw new Error('接口失败')
    if (path.endsWith('/history')) return { items: points }
    if (path.includes('/counts'))
      return {
        entity_type: 'x.profile',
        points: readings.map((followers, i) => ({
          capture_id: `c${i}`,
          observed_at: `2026-10-0${i + 1}T00:00:00Z`,
          counts: { '/metadata/followers': followers },
        })),
      }
    if (path.includes('/profile-changes'))
      return {
        items: Array.from({ length: changes }, (_, i) => ({
          capture_id: `c${i}`,
          revision_id: `r${i}`,
          observed_at: '2026-10-01T00:00:00Z',
          fields: [{ field: 'name', before: 'A', after: 'B' }],
        })),
      }
    if (path.endsWith('/follows')) return followCounts
    if (path.includes('/follow-changes'))
      return {
        items: Array.from({ length: followChanges }, () => ({
          type: 'follow',
          observed_at: '2026-10-02T00:00:00Z',
          since: '2026-10-01T00:00:00Z',
          account: { entity_id: 'e', external_id: '9', name: 'B' },
        })),
      }
    const point = /\/history\/(.+)$/.exec(path)?.[1]
    const at = points.find((p) => p.capture_id === point)
    if (at)
      return {
        ...collection('kept'),
        revision_id: at.revision_id,
        observed_at: at.observed_at,
      }
    if (path.endsWith('/availability')) return { available: true }
    if (path === '/updates') return started
    if (path.endsWith('/update')) return update
    return collection(path.split('/', 3)[2]!)
  })
})
afterEach(() => {
  unmount()
  document.body.replaceChildren()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.resetAllMocks()
})
const calls = (prefix: string) =>
  api.mock.calls.filter(([path]) => path.startsWith(prefix)).length
it('follows only whether its update runs, and reloads once it ends', async () => {
  mount()
  await vi.advanceTimersByTimeAsync(0)
  const d = detail!
  expect(d.record.value).toBe('')
  expect(d.updating.value).toBe(false)
  update = { record: { id: 'record-1', done: false }, older: false }
  await refresh()
  expect(d.record.value).toBe('record-1')
  expect(d.updating.value).toBe(true)
  expect(toastState.value?.text).toBe('已开始更新')
  // While it runs, only the update is asked after; its record shows the rest.
  const before = api.mock.calls.length
  await vi.advanceTimersByTimeAsync(9000)
  expect(
    api.mock.calls.slice(before).every(([path]) => path.endsWith('/update')),
  ).toBe(true)
  expect(updates).toEqual([])
  update = { record: { id: 'record-1', done: true }, older: false }
  await vi.advanceTimersByTimeAsync(3000)
  expect(d.updating.value).toBe(false)
  // 查看进度 stays for the finished update.
  expect(d.record.value).toBe('record-1')
  await vi.waitFor(() =>
    expect(updates.map((value) => value.id)).toEqual(['kept']),
  )
})
it('shows the running update of a collection it opens', async () => {
  update = { record: { id: 'record-0', done: false }, older: true }
  mount()
  await vi.advanceTimersByTimeAsync(0)
  expect(detail!.record.value).toBe('record-0')
  expect(detail!.updating.value).toBe(true)
  expect(detail!.older.value).toBe(true)
})
it('shows what a refresh saved when the reader comes back', async () => {
  mount()
  await vi.advanceTimersByTimeAsync(0)
  const d = detail!
  // Coming back without a refresh keeps the cached view as it was.
  await show('other')
  await show('kept')
  // The collection, its history, counts and update; availability once.
  expect(calls('/collections/kept')).toBe(5)
  update = { record: { id: 'record-1', done: false }, older: false }
  await refresh()
  await show('other')
  await show('kept')
  await vi.waitFor(() =>
    expect(updates.map((value) => value.id)).toEqual(['kept']),
  )
  expect(d.membersVersion.value).toBe(1)
})
it('reports a failed reload after a refresh as a toast', async () => {
  const view = mount()
  await vi.advanceTimersByTimeAsync(0)
  update = { record: { id: 'record-1', done: false }, older: false }
  await refresh()
  await show('other')
  rejects.add('/collections/kept')
  await show('kept')
  // The collection is still on screen, so the failure shows as a toast.
  await vi.waitFor(() => expect(toastState.value?.text).toBe('接口失败'))
  expect(view.error()).toBe('')
  expect(updates).toEqual([])
})
// Newest first: a content change, then a change of counts alone.
const history: HistoryPoint[] = [
  { capture_id: 'c3', observed_at: '2026-10-01T00:00:00Z', revision_id: 'r1' },
  { capture_id: 'c2', observed_at: '2026-09-01T00:00:00Z', revision_id: 'r0' },
  { capture_id: 'c1', observed_at: '2026-08-01T00:00:00Z', revision_id: 'r0' },
]
/** Mount the kept collection with its history loaded. */
async function withHistory() {
  points = history
  mount()
  await vi.advanceTimersByTimeAsync(0)
  const d = detail!
  expect(d.points.value.map((p) => p.capture_id)).toEqual(['c3', 'c2', 'c1'])
  return d
}
it('steps through points, each its own view even on one revision', async () => {
  const d = await withHistory()
  // The newest point is the current state, already on screen.
  expect(d.shownPoint.value).toBe('c3')
  expect(d.latestPoint.value).toBe('c3')
  expect(d.historical.value).toBe(false)
  expect(d.isSeen('c3')).toBe(true)
  expect(d.isSeen('c2')).toBe(false)
  await d.showPoint('c2')
  expect(d.collection.value?.observed_at).toBe('2026-09-01T00:00:00Z')
  expect(d.shownPoint.value).toBe('c2')
  expect(d.historical.value).toBe(true)
  // c1 has c2's revision but not its counts: fetched, not taken from c2.
  await d.showPoint('c1')
  expect(d.collection.value?.observed_at).toBe('2026-08-01T00:00:00Z')
  expect(calls('/collections/kept/history/')).toBe(2)
  // Points seen before, and the current state, show without a request.
  const before = api.mock.calls.length
  await d.showPoint('c2')
  expect(d.collection.value?.observed_at).toBe('2026-09-01T00:00:00Z')
  await d.showPoint('c3')
  expect(d.historical.value).toBe(false)
  expect(d.collection.value?.revision_id).toBe('r1')
  expect(api.mock.calls.length).toBe(before)
})
it('lets a newer point supersede one still loading', async () => {
  const d = await withHistory()
  const slow = hold('/collections/kept/history/c2')
  const first = d.showPoint('c2')
  await slow.reached()
  // The current state stays on screen, dimmed, while c2 loads.
  expect(d.loadingPoint.value).toBe(true)
  expect(d.shownPoint.value).toBe('c3')
  await d.showPoint('c1')
  expect(d.shownPoint.value).toBe('c1')
  expect(d.loadingPoint.value).toBe(false)
  await slow.release()
  await first
  // The late reply is kept for later but does not replace c1.
  expect(d.shownPoint.value).toBe('c1')
  expect(d.collection.value?.observed_at).toBe('2026-08-01T00:00:00Z')
  expect(d.isSeen('c2')).toBe(true)
})
it('drops a point still loading when the drag returns to the one shown', async () => {
  const d = await withHistory()
  const slow = hold('/collections/kept/history/c2')
  const first = d.showPoint('c2')
  await slow.reached()
  await d.showPoint('c3')
  expect(d.loadingPoint.value).toBe(false)
  await slow.release()
  await first
  expect(d.shownPoint.value).toBe('c3')
  expect(d.historical.value).toBe(false)
  expect(d.collection.value?.revision_id).toBe('r1')
})
it('offers trends once two captures read a count', async () => {
  readings = [10]
  mount()
  await vi.advanceTimersByTimeAsync(0)
  const d = detail!
  // Two readings are enough to tell, so no more are asked for.
  expect(api).toHaveBeenCalledWith(
    '/collections/kept/counts?limit=2',
    expect.anything(),
  )
  expect(d.trendable.value).toBe(false)
  // A refresh that reads the counts again makes a trend.
  readings = [10, 12]
  await refresh()
  await show('other')
  await show('kept')
  await vi.waitFor(() => expect(d.trendable.value).toBe(true))
  expect(calls('/collections/kept/counts')).toBe(2)
})
it('offers the record of changes once a profile changed', async () => {
  profile = true
  mount()
  await vi.advanceTimersByTimeAsync(0)
  const d = detail!
  // The newest change is enough to tell.
  expect(api).toHaveBeenCalledWith(
    '/collections/kept/profile-changes?limit=1',
    expect.anything(),
  )
  expect(d.changeable.value).toBe(false)
  // A refresh that sees the profile change offers it.
  changes = 1
  await refresh()
  await show('other')
  await show('kept')
  await vi.waitFor(() => expect(d.changeable.value).toBe(true))
  expect(calls('/collections/kept/profile-changes')).toBe(2)
})
it('never asks for the changes of anything but a profile', async () => {
  changes = 1
  mount()
  await vi.advanceTimersByTimeAsync(0)
  expect(detail!.collection.value?.id).toBe('kept')
  expect(calls('/collections/kept/profile-changes')).toBe(0)
  expect(detail!.changeable.value).toBe(false)
})
it('reads older posts right away, and shows what the lists found on return', async () => {
  profile = true
  mount()
  await vi.advanceTimersByTimeAsync(0)
  const d = detail!
  // Nothing observed yet: no counts and no record of follow changes.
  expect(api).toHaveBeenCalledWith(
    '/collections/kept/follow-changes?limit=1',
    expect.anything(),
  )
  expect(d.follows.value).toBeUndefined()
  expect(d.followChangeable.value).toBe(false)

  await d.update({ older: true })
  const [, request] = api.mock.calls.find(([path]) => path === '/updates')!
  expect(JSON.parse(request.body!)).toEqual({
    target: { target: 'collection', id: 'kept' },
    older: true,
  })
  // The lists are followed on the record; coming back shows what they found.
  followCounts = { following: 2, followers: 0, mutual: 0 }
  followChanges = 1
  await show('other')
  await show('kept')
  await vi.waitFor(() => expect(d.followChangeable.value).toBe(true))
  expect(d.follows.value).toEqual({ following: 2, followers: 0, mutual: 0 })
})
it('updates without the lists unless asked, and never asks a post for follows', async () => {
  mount()
  await vi.advanceTimersByTimeAsync(0)
  await refresh()
  const [, request] = api.mock.calls.find(([path]) => path === '/updates')!
  expect(JSON.parse(request.body!)).toEqual({
    target: { target: 'collection', id: 'kept' },
  })
  expect(calls('/collections/kept/follow')).toBe(0)
})
