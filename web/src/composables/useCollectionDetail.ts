import { computed, onActivated, onUnmounted, shallowRef, watch } from 'vue'
import {
  call,
  client,
  errorText,
  type Collection,
  type HistoryPoint,
} from '../api'
import { isProfileEntity } from '../relations'
import { trends } from '../trends'
import { toast } from './useToast'
const collections = client.collections[':id']
const getCollection = (id: string, signal: AbortSignal) =>
  call(collections.$get({ param: { id } }, { init: { signal } }))
const availability = async (id: string, signal: AbortSignal) =>
  (
    await call(
      collections.availability.$get({ param: { id } }, { init: { signal } }),
    )
  ).available
export function useCollectionDetail(
  id: () => string,
  deleted: (id: string) => void,
  updated: (collection: Collection) => void,
) {
  const available = shallowRef(false)
  const collection = shallowRef<Collection>()
  const error = shallowRef('')
  const busy = shallowRef(false)
  /** The capture record of the refresh started here, which shows its progress. */
  const record = shallowRef('')
  /** Captures where the content or counts changed, newest first. */
  const points = shallowRef<HistoryPoint[]>([])
  const next = shallowRef('')
  const latestRevision = shallowRef('')
  const loadingPoint = shallowRef(false)
  const historyLoading = shallowRef(false)
  const confirmDelete = shallowRef(false)
  /** At least two captures read a count, so the page of trends has a line. */
  const trendable = shallowRef(false)
  /** A profile whose shown fields changed at least once. */
  const changeable = shallowRef(false)
  /** The newest point is the collection as it is now. */
  const latestPoint = computed(() => points.value[0]?.capture_id ?? '')
  /** The point on screen; '' is the current state. */
  const selected = shallowRef('')
  const key = (point: string) => (point === latestPoint.value ? '' : point)
  /**
   * Points already fetched, by `key`, so moving back to one shows it at once.
   * The current state is kept under '' rather than its point, which a
   * refresh can move on from.
   */
  const seen = new Map<string, Collection>()
  const show = (result: Collection) => {
    seen.set('', result)
    selected.value = ''
    collection.value = result
  }
  /**
   * Bumped whenever the collection is reloaded after a refresh, so lists of
   * its members (such as a profile's posts) know to reload too.
   */
  const membersVersion = shallowRef(0)
  const historical = computed(() => key(selected.value) !== '')
  /** The point the timeline marks as shown. */
  const shownPoint = computed(() =>
    historical.value ? selected.value : latestPoint.value,
  )
  let controller = new AbortController()
  // Once the collection is on screen, a failed action must not replace it or
  // land in a banner out of view: say so where the reader is looking.
  function report(e: unknown) {
    const text = errorText(e)
    if (collection.value) toast(text)
    else error.value = text
  }
  async function checkAvailability() {
    try {
      available.value = await availability(id(), controller.signal)
    } catch (e) {
      if (!controller.signal.aborted) {
        available.value = false
        report(e)
      }
    }
  }
  let pointRequest = 0
  // Progress is followed on the refresh's record, not here. Coming back from
  // there shows whatever the refresh has saved by then.
  let refreshed = false
  onActivated(() => {
    if (refreshed) void reload()
  })
  watch(
    id,
    async (id) => {
      controller.abort()
      controller = new AbortController()
      refreshed = false
      const signal = controller.signal
      ++pointRequest
      collection.value = undefined
      seen.clear()
      selected.value = ''
      points.value = []
      latestRevision.value = ''
      loadingPoint.value = false
      historyLoading.value = false
      next.value = ''
      record.value = ''
      error.value = ''
      busy.value = false
      available.value = false
      confirmDelete.value = false
      trendable.value = false
      changeable.value = false
      try {
        const result = await getCollection(id, signal)
        if (signal.aborted) return
        show(result)
        latestRevision.value = result.revision_id
        void historyPage()
        void checkTrends()
        void checkChanges(result)
        available.value = await availability(id, signal)
      } catch (e) {
        if (!signal.aborted) error.value = errorText(e)
      }
    },
    { immediate: true },
  )
  onUnmounted(() => controller.abort())
  /**
   * Whether the collection has trends: two readings are enough to tell, so
   * the detail asks for no more than that and leaves the series to its page.
   */
  async function checkTrends() {
    if (trendable.value) return
    const signal = controller.signal
    try {
      const series = await call(
        collections.counts.$get(
          { param: { id: id() }, query: { limit: '2' } },
          { init: { signal } },
        ),
      )
      if (!signal.aborted) trendable.value = trends(series).length > 0
    } catch {
      // Without an answer the page is not offered; nothing else depends on it.
    }
  }
  /**
   * Whether a profile has a record of changes: the newest one is enough to
   * tell. Anything but a profile has none, so it is not asked.
   */
  async function checkChanges(result: Collection) {
    const graph = result.graph
    const root = graph?.entities.find((entity) => entity.key === graph.root)
    if (changeable.value || !isProfileEntity(root)) return
    const signal = controller.signal
    try {
      const changes = await call(
        collections['profile-changes'].$get(
          { param: { id: id() }, query: { limit: '1' } },
          { init: { signal } },
        ),
      )
      // An answer without a list, as from an older server, offers nothing.
      if (!signal.aborted) changeable.value = !!changes.items?.length
    } catch {
      // Without an answer the page is not offered; nothing else depends on it.
    }
  }
  async function historyPage(more = false) {
    if (historyLoading.value || (more && !next.value)) return
    const signal = controller.signal
    historyLoading.value = true
    try {
      const p = await call(
        collections.history.$get(
          { param: { id: id() }, query: more ? { cursor: next.value } : {} },
          { init: { signal } },
        ),
      )
      if (signal.aborted) return
      points.value = more ? [...points.value, ...p.items] : p.items
      next.value = p.next_cursor || ''
    } catch (e) {
      if (!signal.aborted) report(e)
    } finally {
      if (!signal.aborted) historyLoading.value = false
    }
  }
  /**
   * Show a point of the history, or the current state without one. A newer
   * request supersedes one still loading, so a timeline can be dragged
   * across points.
   */
  async function showPoint(point?: string) {
    if (busy.value) return
    const target = key(point ?? '')
    // Any request still loading is superseded, even by moving back to the
    // point shown.
    ++pointRequest
    if (target === key(selected.value)) {
      loadingPoint.value = false
      return
    }
    const known = seen.get(target)
    if (known) {
      selected.value = target
      collection.value = known
      loadingPoint.value = false
      return
    }
    const request = pointRequest
    const signal = controller.signal
    loadingPoint.value = true
    error.value = ''
    try {
      const result = target
        ? await call(
            collections.history[':capture'].$get(
              { param: { id: id(), capture: target } },
              { init: { signal } },
            ),
          )
        : await getCollection(id(), signal)
      if (signal.aborted) return
      seen.set(target, result)
      if (request !== pointRequest) return
      selected.value = target
      collection.value = result
      if (!target) latestRevision.value = result.revision_id
    } catch (e) {
      if (!signal.aborted && request === pointRequest) report(e)
    } finally {
      if (!signal.aborted && request === pointRequest)
        loadingPoint.value = false
    }
  }
  async function remove() {
    busy.value = true
    try {
      await call(
        collections.$delete(
          { param: { id: id() } },
          { init: { signal: controller.signal } },
        ),
      )
      deleted(id())
    } catch (e) {
      report(e)
    } finally {
      busy.value = false
    }
  }
  /** Show the collection as it is now, keeping the page on screen meanwhile. */
  async function reload() {
    const signal = controller.signal
    try {
      const result = await getCollection(id(), signal)
      if (signal.aborted) return
      ++pointRequest
      loadingPoint.value = false
      show(result)
      latestRevision.value = result.revision_id
      void checkTrends()
      void checkChanges(result)
      void historyPage()
      updated(result)
      membersVersion.value++
    } catch (e) {
      if (!signal.aborted) report(e)
    }
  }
  async function refresh() {
    if (busy.value) return
    busy.value = true
    try {
      const job = await call(
        client.captures.$post(
          { json: { refresh_id: id() } },
          {
            headers: { 'Idempotency-Key': crypto.randomUUID() },
            init: { signal: controller.signal },
          },
        ),
      )
      if (controller.signal.aborted) return
      record.value = job.record_id
      refreshed = true
      toast('已开始重新抓取')
    } catch (e) {
      if (!controller.signal.aborted) report(e)
    } finally {
      busy.value = false
    }
  }
  return {
    collection,
    error,
    busy,
    record,
    points,
    next,
    historical,
    latestPoint,
    shownPoint,
    latestRevision,
    historyLoading,
    loadingPoint,
    confirmDelete,
    available,
    trendable,
    changeable,
    historyPage,
    showPoint,
    /** Whether a point shows without a request. */
    isSeen: (point: string) => seen.has(key(point)),
    remove,
    refresh,
    checkAvailability,
    membersVersion,
  }
}
