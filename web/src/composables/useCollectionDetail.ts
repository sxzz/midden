import { onActivated, onDeactivated, onUnmounted, shallowRef, watch } from 'vue'
import {
  call,
  client,
  errorText,
  type Collection,
  type FollowCounts,
} from '../api'
import {
  readCollection,
  readCounts,
  readFollowChanges,
  readFollows,
  readProfileChanges,
} from '../reads'
import { isProfileEntity } from '../relations'
import { shareSlug } from '../share'
import { trends } from '../trends'
import { useHistory } from './useHistory'
import { toast } from './useToast'
const collections = client.collections[':id']
const getCollection = readCollection
/** How often media a restore downloads again is looked at. */
const RESTORE_POLL = 3000
/** Some of its media is downloading again after a restore (恢复下载). */
const restoring = (collection?: Collection) =>
  !!collection &&
  (collection.assets.some((asset) => asset.restoring) ||
    !!collection.graph?.entities.some((entity) =>
      entity.assets?.some((asset) => asset.restoring),
    ))
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
  const confirmDelete = shallowRef(false)
  /** At least two captures read a count, so the page of trends has a line. */
  const trendable = shallowRef(false)
  /** A profile whose shown fields changed at least once. */
  const changeable = shallowRef(false)
  /** Follows of a profile as observed, when any were. */
  const follows = shallowRef<FollowCounts>()
  /** A profile whose follows changed at least once. */
  const followChangeable = shallowRef(false)
  /**
   * Bumped whenever the collection is reloaded after a refresh, so lists of
   * its members (such as a profile's posts) know to reload too.
   */
  const membersVersion = shallowRef(0)
  let controller = new AbortController()
  /** Polls the running update; only while the page is shown. */
  let updateTimer: ReturnType<typeof setTimeout> | undefined
  /** Polls media a restore downloads again; only while the page is shown. */
  let restoreTimer: ReturnType<typeof setTimeout> | undefined
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
  const history = useHistory(id, {
    signal: () => controller.signal,
    report,
    blocked: () => busy.value,
  })
  const { collection, show, historyPage } = history
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
      history.reset()
      record.value = ''
      updating.value = false
      older.value = false
      clearTimeout(updateTimer)
      clearTimeout(restoreTimer)
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
    clearTimeout(restoreTimer)
  })
  onActivated(() => {
    active = true
    if (updating.value) void checkUpdate()
    followRestore()
  })
  onDeactivated(() => {
    active = false
    clearTimeout(updateTimer)
    clearTimeout(restoreTimer)
  })
  /**
   * Media a restore downloads again shows its kept thumbnail meanwhile: the
   * collection is looked at every few seconds, and read again in place (as
   * after an update) once none of it is downloading any more.
   */
  function followRestore() {
    clearTimeout(restoreTimer)
    if (active && !shareSlug.value && restoring(collection.value))
      restoreTimer = setTimeout(checkRestore, RESTORE_POLL)
  }
  async function checkRestore() {
    const signal = controller.signal
    try {
      const result = await getCollection(id(), signal)
      if (signal.aborted) return
      if (!restoring(result)) {
        void reload()
        return
      }
    } catch {
      // Looked at again next time; nothing else depends on it.
      if (signal.aborted) return
    }
    if (active) restoreTimer = setTimeout(checkRestore, RESTORE_POLL)
  }
  watch(collection, followRestore)
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
  /**
   * Show the collection as it is now, keeping the page on screen meanwhile.
   * Coming back to the page after an update can ask twice at once (the
   * update's end, and the return itself): one read answers both, so its
   * related list reloads once.
   */
  let reloading: Promise<void> | undefined
  function reload() {
    reloading ??= read().finally(() => (reloading = undefined))
    return reloading
  }
  async function read() {
    const signal = controller.signal
    try {
      const result = await getCollection(id(), signal)
      if (signal.aborted) return
      show(result)
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
   * Update the collection right away with the default options: a profile's
   * older posts (`older`). Other updates start from the sheet, which calls
   * `started`.
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
    points: history.points,
    next: history.next,
    historical: history.historical,
    latestPoint: history.latestPoint,
    shownPoint: history.shownPoint,
    latestRevision: history.latestRevision,
    historyLoading: history.historyLoading,
    loadingPoint: history.loadingPoint,
    confirmDelete,
    available,
    trendable,
    changeable,
    follows,
    followChangeable,
    historyPage,
    showPoint: history.showPoint,
    preview: history.preview,
    /** Whether a point shows without a request. */
    isSeen: history.isSeen,
    reload,
    update,
    started,
    updating,
    older,
    checkAvailability,
    membersVersion,
  }
}
