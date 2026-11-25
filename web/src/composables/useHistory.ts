import { computed, onUnmounted, shallowRef } from 'vue'
import { readCollection, readHistory, readHistoryPoint } from '../reads'
import type { Collection, HistoryPoint } from '../api'

/**
 * A collection's history: its points, and the collection as it looked at the
 * one on screen. The caller owns the request lifetime (`signal`) and decides
 * how failures read (`report`); `blocked` holds the timeline still while an
 * action of the page runs.
 */
export function useHistory(
  id: () => string,
  options: {
    signal: () => AbortSignal
    report: (e: unknown) => void
    blocked?: () => boolean
  },
) {
  /** The collection at the point on screen. */
  const collection = shallowRef<Collection>()
  /** Captures where the content or counts changed, newest first. */
  const points = shallowRef<HistoryPoint[]>([])
  const next = shallowRef('')
  /** The newest revision, whichever point is on screen. */
  const latestRevision = shallowRef('')
  const loadingPoint = shallowRef(false)
  const historyLoading = shallowRef(false)
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
  const historical = computed(() => key(selected.value) !== '')
  /** The point the timeline marks as shown. */
  const shownPoint = computed(() =>
    historical.value ? selected.value : latestPoint.value,
  )
  let pointRequest = 0
  // Dragging the timeline passes many points: show the ones already fetched
  // at once, and fetch the others only where the drag rests.
  let pick: ReturnType<typeof setTimeout> | undefined
  onUnmounted(() => clearTimeout(pick))
  /** Forget everything, for another collection. */
  function reset() {
    ++pointRequest
    clearTimeout(pick)
    collection.value = undefined
    seen.clear()
    selected.value = ''
    points.value = []
    latestRevision.value = ''
    loadingPoint.value = false
    historyLoading.value = false
    next.value = ''
  }
  /** Show the collection as it is now, over any point still loading. */
  function show(result: Collection) {
    ++pointRequest
    clearTimeout(pick)
    loadingPoint.value = false
    seen.set('', result)
    selected.value = ''
    collection.value = result
    latestRevision.value = result.revision_id
  }
  async function historyPage(more = false) {
    if (historyLoading.value || (more && !next.value)) return
    const signal = options.signal()
    historyLoading.value = true
    try {
      const p = await readHistory(id(), more ? next.value : '', signal)
      if (signal.aborted) return
      points.value = more ? [...points.value, ...p.items] : p.items
      next.value = p.next_cursor || ''
    } catch (e) {
      if (!signal.aborted) options.report(e)
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
    if (options.blocked?.()) return
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
    const signal = options.signal()
    loadingPoint.value = true
    try {
      const result = target
        ? await readHistoryPoint(id(), target, signal)
        : await readCollection(id(), signal)
      if (signal.aborted) return
      seen.set(target, result)
      if (request !== pointRequest) return
      selected.value = target
      collection.value = result
      if (!target) latestRevision.value = result.revision_id
    } catch (e) {
      if (!signal.aborted && request === pointRequest) options.report(e)
    } finally {
      if (!signal.aborted && request === pointRequest)
        loadingPoint.value = false
    }
  }
  function preview(point: string) {
    clearTimeout(pick)
    if (seen.has(key(point))) void showPoint(point)
    else pick = setTimeout(showPoint, 150, point)
  }
  return {
    collection,
    points,
    next,
    historical,
    latestPoint,
    shownPoint,
    latestRevision,
    historyLoading,
    loadingPoint,
    reset,
    show,
    historyPage,
    showPoint,
    preview,
    /** Whether a point shows without a request. */
    isSeen: (point: string) => seen.has(key(point)),
  }
}
