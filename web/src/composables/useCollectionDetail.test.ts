import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp, h, KeepAlive, nextTick, shallowRef } from 'vue'
import { collection as fixture, mockApi } from '../testing/api'
import { useCollectionDetail } from './useCollectionDetail'
import { toastState } from './useToast'
import type { Collection, HistoryPoint, Job } from '../api'
const { replace } = vi.hoisted(() => ({ replace: vi.fn() }))
vi.mock('vue-router', () => ({ useRouter: () => ({ replace }) }))
const collection = (id: string): Collection =>
  fixture({
    id,
    url: 'https://example.test/item',
    text: '合成正文',
    author_name: '合成作者',
    observed_at: '2026-10-01T00:00:00Z',
    revision_id: 'r1',
  })
let api = mockApi()
let job: Job = { id: 'job-1', collection_id: 'kept', state: 'queued' }
/** The history every collection answers with. */
let points: HistoryPoint[] = []
/** The kept collection's composable, for tests that step through points. */
let detail: ReturnType<typeof useCollectionDetail> | undefined
/** One shared refresh handle, so the test can start a capture and watch it. */
let refresh = async () => {}
/** Collections handed to the library list, to catch writes from a cached view. */
let updates: Collection[] = []
/**
 * Requests held open on purpose, so a reply can land only after the view has
 * been navigated away from and put in the cache.
 */
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
      () => {},
      (value) => updates.push(value),
    )
    if (props.id === 'kept') {
      refresh = () => used.refresh()
      detail = used
    }
    return () => [
      h('p', { class: 'status' }, used.status.value),
      h('p', { class: 'error' }, used.error.value),
    ]
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
  return {
    status: () => el.querySelector('.status')?.textContent,
    error: () => el.querySelector('.error')?.textContent,
  }
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
  job = { id: 'job-1', collection_id: 'kept', state: 'queued' }
  updates = []
  gates = new Map()
  rejects = new Set()
  points = []
  detail = undefined
  api = mockApi(async (path) => {
    const gate = gates.get(path)
    if (gate) {
      gates.delete(path)
      await gate.wait
    }
    if (rejects.has(path)) throw new Error('接口失败')
    if (path.endsWith('/history')) return { items: points }
    const point = /\/history\/(.+)$/.exec(path)?.[1]
    const at = points.find((p) => p.capture_id === point)
    if (at)
      return {
        ...collection('kept'),
        revision_id: at.revision_id,
        observed_at: at.observed_at,
      }
    if (path.endsWith('/availability')) return { available: true }
    if (path === '/captures' || path.startsWith('/jobs/')) return job
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
it('stops polling a capture while the detail is cached and resumes on return', async () => {
  const view = mount()
  await vi.advanceTimersByTimeAsync(0)
  await refresh()
  expect(view.status()).toBe('正在采集…')
  // Navigating to another collection puts this one in the cache.
  await show('other')
  await vi.advanceTimersByTimeAsync(10_000)
  expect(calls('/jobs/')).toBe(0)
  // Coming back resumes the pending job instead of starting a new capture.
  job = { ...job, state: 'complete' }
  await show('kept')
  await vi.advanceTimersByTimeAsync(2000)
  await vi.waitFor(() => expect(view.status()).toBe('已更新。'))
  expect(calls('/jobs/')).toBe(1)
  expect(calls('/captures')).toBe(1)
})
it('keeps one poll timer when a job reply lands after the view came back', async () => {
  const view = mount()
  await vi.advanceTimersByTimeAsync(0)
  await refresh()
  // Let the first job request go out, then leave it unanswered in flight.
  const jobs = hold('/jobs/job-1')
  await vi.advanceTimersByTimeAsync(2000)
  await jobs.reached()
  expect(calls('/jobs/')).toBe(1)
  await show('other')
  await show('kept')
  // The stale reply must retire instead of scheduling a chain of its own.
  await jobs.release()
  expect(view.status()).toBe('正在采集…')
  await vi.advanceTimersByTimeAsync(2000)
  expect(calls('/jobs/')).toBe(2)
  await vi.advanceTimersByTimeAsync(2000)
  expect(calls('/jobs/')).toBe(3)
})
it('does not reroute or touch the list when a capture finishes while cached', async () => {
  job = { id: 'job-1', collection_id: 'moved', state: 'queued' }
  mount()
  await vi.advanceTimersByTimeAsync(0)
  await refresh()
  job = { ...job, state: 'complete' }
  // Hold the collection reload that follows a finished job.
  const reload = hold('/collections/moved')
  await vi.advanceTimersByTimeAsync(2000)
  await reload.reached()
  await show('other')
  await reload.release()
  expect(replace).not.toHaveBeenCalled()
  expect(updates).toEqual([])
})
it('defers the list update when the view is cached during its history reload', async () => {
  mount()
  await vi.advanceTimersByTimeAsync(0)
  await refresh()
  job = { ...job, state: 'complete' }
  // The initial load already fetched the history; hold the one inside the job.
  const history = hold('/collections/kept/history')
  await vi.advanceTimersByTimeAsync(2000)
  await history.reached()
  await show('other')
  await history.release()
  expect(updates).toEqual([])
  // Returning finishes the job and only then reports it to the list.
  await show('kept')
  await vi.advanceTimersByTimeAsync(0)
  expect(updates.map((value) => value.id)).toEqual(['kept'])
})
it('reports a failure from resuming a capture instead of rejecting', async () => {
  const view = mount()
  await vi.advanceTimersByTimeAsync(0)
  await refresh()
  job = { ...job, state: 'complete' }
  const reload = hold('/collections/kept')
  await vi.advanceTimersByTimeAsync(2000)
  await reload.reached()
  await show('other')
  await reload.release()
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
