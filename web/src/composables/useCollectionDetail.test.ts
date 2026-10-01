import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp, h, KeepAlive, nextTick, shallowRef } from 'vue'
import { api, type Collection, type Job } from '../api'
import { useCollectionDetail } from './useCollectionDetail'
const { replace } = vi.hoisted(() => ({ replace: vi.fn() }))
vi.mock('vue-router', () => ({ useRouter: () => ({ replace }) }))
vi.mock('../api', async (original) => ({
  ...(await original<typeof import('../api')>()),
  api: vi.fn(),
}))
const collection = (id: string): Collection => ({
  id,
  url: 'https://example.test/item',
  text: '合成正文',
  author_name: '合成作者',
  observed_at: '2026-10-01T00:00:00Z',
  visibility: 'public',
  revision_id: 'r1',
  assets: [],
})
let job: Job = { id: 'job-1', collection_id: 'kept', state: 'queued' }
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
    const detail = useCollectionDetail(
      () => props.id,
      () => {},
      (value) => updates.push(value),
    )
    if (props.id === 'kept') refresh = detail.refresh
    return () => [
      h('p', { class: 'status' }, detail.status.value),
      h('p', { class: 'error' }, detail.error.value),
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
  vi.mocked(api).mockImplementation(async (path: string) => {
    const gate = gates.get(path)
    if (gate) {
      gates.delete(path)
      await gate.wait
    }
    if (rejects.has(path)) throw new Error('接口失败')
    if (path.endsWith('/revisions')) return { items: [] }
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
  vi.mocked(api).mock.calls.filter(([path]) => path.startsWith(prefix)).length
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
  job = { ...job, state: 'ready' }
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
  job = { ...job, state: 'ready' }
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
  job = { ...job, state: 'ready' }
  // The initial load already fetched revisions; hold the one inside the job.
  const history = hold('/collections/kept/revisions')
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
  job = { ...job, state: 'ready' }
  const reload = hold('/collections/kept')
  await vi.advanceTimersByTimeAsync(2000)
  await reload.reached()
  await show('other')
  await reload.release()
  rejects.add('/collections/kept')
  await show('kept')
  await vi.waitFor(() => expect(view.error()).toBe('接口失败'))
  expect(updates).toEqual([])
})
