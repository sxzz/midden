import {
  computed,
  onActivated,
  onDeactivated,
  onUnmounted,
  shallowRef,
  watch,
} from 'vue'
import {
  call,
  client,
  errorText,
  type Collection,
  type FollowCounts,
  type HistoryPoint,
} from '../api'
import {
  readCollection,
  readCounts,
  readFollowChanges,
  readFollows,
  readHistory,
  readHistoryPoint,
  readProfileChanges,
} from '../reads'
import { isProfileEntity } from '../relations'
import { shareSlug } from '../share'
import { trends } from '../trends'
import { toast } from './useToast'
const collections = client.collections[':id']
const getCollection = readCollection
const availability = async (id: string, signal: AbortSignal) =>
  (
    await call(
      collections.availability.$get({ param: { id } }, { init: { signal } }),
    )
  ).available
export function useCollectionDetail(
  id: () => string,
  updated: (collection: Collection) => void,
) {
  const available = shallowRef(false)
  const collection = shallowRef<Collection>()
  const error = shallowRef('')
  const busy = shallowRef(false)
  /**
   * The record of this collection's update while it runs or for a while
   * after, which shows its progress; '' when there is none.
   */
  const record = shallowRef('')
  /** That update is still running. */
  const updating = shallowRef(false)
  /** A profile with older posts to read after its last page. */
  const older = shallowRef(false)
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
  /** Follows of a profile as observed, when any were. */
  const follows = shallowRef<FollowCounts>()
  /** A profile whose follows changed at least once. */
  const followChangeable = shallowRef(false)
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
  /** Polls the running update; only while the page is shown. */
  let updateTimer: ReturnType<typeof setTimeout> | undefined
  let active = true
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
      updating.value = false
      older.value = false
      clearTimeout(updateTimer)
      error.value = ''
      busy.value = false
      available.value = false
      confirmDelete.value = false
      trendable.value = false
      changeable.value = false
      follows.value = undefined
      followChangeable.value = false
      try {
        const result = await getCollection(id, signal)
        if (signal.aborted) return
        show(result)
        latestRevision.value = result.revision_id
        void historyPage()
        void checkTrends()
        void checkChanges(result)
        void checkFollows(result)
        // A public page offers no capture to check for.
        if (!shareSlug.value) {
          void checkUpdate()
          available.value = await availability(id, signal)
        }
      } catch (e) {
        if (!signal.aborted) error.value = errorText(e)
      }
    },
    { immediate: true },
  )
  onUnmounted(() => {
    controller.abort()
    clearTimeout(updateTimer)
  })
  onActivated(() => {
    active = true
    if (updating.value) void checkUpdate()
  })
  onDeactivated(() => {
    active = false
    clearTimeout(updateTimer)
  })
  /**
   * The update of this collection to follow, polled while it runs. Once it
   * ends the collection is read again, so the page shows what it saved.
   */
  async function checkUpdate() {
    clearTimeout(updateTimer)
    if (shareSlug.value) return
    const signal = controller.signal
    const was = updating.value
    try {
      const found = await call(
        collections.update.$get({ param: { id: id() } }, { init: { signal } }),
      )
      if (signal.aborted) return
      record.value = found.record?.id ?? ''
      updating.value = !!found.record && !found.record.done
      older.value = found.older
      if (was && !updating.value) void reload()
      if (updating.value && active) updateTimer = setTimeout(checkUpdate, 3000)
    } catch {
      // Without an answer there is no progress to link to; nothing else
      // depends on it.
    }
  }
  /**
   * Whether the collection has trends: two readings are enough to tell, so
   * the detail asks for no more than that and leaves the series to its page.
   */
  async function checkTrends() {
    if (trendable.value) return
    const signal = controller.signal
    try {
      const series = await readCounts(id(), 2, signal)
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
      const changes = await readProfileChanges(id(), 1, signal)
      // An answer without a list, as from an older server, offers nothing.
      if (!signal.aborted) changeable.value = !!changes.items?.length
    } catch {
      // Without an answer the page is not offered; nothing else depends on it.
    }
  }
  /**
   * The follows observed of a profile and whether they ever changed (the
   * newest change is enough to tell). Neither is shown without data.
   */
  async function checkFollows(result: Collection) {
    const graph = result.graph
    const root = graph?.entities.find((entity) => entity.key === graph.root)
    if (!isProfileEntity(root)) return
    const signal = controller.signal
    try {
      const [counts, changes] = await Promise.all([
        readFollows(id(), signal),
        readFollowChanges(id(), 1, signal),
      ])
      if (signal.aborted) return
      follows.value = counts.following === undefined ? undefined : counts
      followChangeable.value = !!changes.items?.length
    } catch {
      // Without an answer nothing is shown; nothing else depends on it.
    }
  }
  async function historyPage(more = false) {
    if (historyLoading.value || (more && !next.value)) return
    const signal = controller.signal
    historyLoading.value = true
    try {
      const p = await readHistory(id(), more ? next.value : '', signal)
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
        ? await readHistoryPoint(id(), target, signal)
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
      void checkFollows(result)
      void historyPage()
      updated(result)
      membersVersion.value++
    } catch (e) {
      if (!signal.aborted) report(e)
    }
  }
  /**
   * Update the collection right away with the default options: a post whose
   * media came back, or a profile's older posts (`older`). Other updates
   * start from the sheet, which calls `started`.
   */
  async function update(body: { older?: boolean } = {}) {
    if (busy.value) return
    busy.value = true
    try {
      const result = await call(
        client.updates.$post(
          {
            json: {
              target: { target: 'collection', id: id() },
              ...(body.older ? { older: true } : {}),
            },
          },
          {
            headers: { 'Idempotency-Key': crypto.randomUUID() },
            init: { signal: controller.signal },
          },
        ),
      )
      if (controller.signal.aborted) return
      toast(body.older ? '已开始抓取更早的帖子' : '已开始更新')
      started(result.id)
    } catch (e) {
      if (!controller.signal.aborted) report(e)
    } finally {
      busy.value = false
    }
  }
  /** An update of this collection started: follow it to its end. */
  function started(recordId: string) {
    record.value = recordId
    updating.value = true
    refreshed = true
    void checkUpdate()
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
    follows,
    followChangeable,
    historyPage,
    showPoint,
    /** Whether a point shows without a request. */
    isSeen: (point: string) => seen.has(key(point)),
    reload,
    update,
    started,
    updating,
    older,
    checkAvailability,
    membersVersion,
  }
}
