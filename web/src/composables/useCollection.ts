import { onUnmounted, shallowRef } from 'vue'
import { errorText, type Collection } from '../api'
import { localZone } from '../folders'
import { listSort } from '../presentation'
import { hasDates } from '../query'
import { readCount, readList } from '../reads'
/** The list's API query for a route query. */
function request(params: string) {
  const q = new URLSearchParams(params)
  if (!q.has('entity_type')) q.set('entity_type', 'x.post,instagram.post')
  q.delete('layout')
  q.delete('tab')
  q.set('sort', listSort(q))
  for (const [local, apiKey] of [
    ['from_date', 'saved_from'],
    ['to_date', 'saved_before'],
  ] as const) {
    const value = q.get(local)
    q.delete(local)
    if (!value) continue
    const date = new Date(`${value}T00:00:00`)
    if (!Number.isFinite(date.getTime())) continue
    if (local === 'to_date') date.setDate(date.getDate() + 1)
    q.set(apiKey, date.toISOString())
  }
  // Save dates and the query's own dates count days where the reader is.
  if ((q.get('saved_within') || hasDates(q.get('q'))) && !q.get('tz'))
    q.set('tz', localZone())
  q.set('q', q.get('q') || '')
  return q
}
/** One page of the library list for a route query. */
function page(params: string, cursor: string, signal: AbortSignal) {
  const q = request(params)
  if (cursor) q.set('cursor', cursor)
  return readList(q, signal)
}
export function useCollection() {
  const items = shallowRef<Collection[]>([])
  const next = shallowRef('')
  const totalStorageBytes = shallowRef<number>()
  /** How many the list holds over all its pages, once counted. */
  const total = shallowRef<number>()
  const loading = shallowRef(false)
  /** A soft refresh is running; the current items stay on screen meanwhile. */
  const refreshing = shallowRef(false)
  const error = shallowRef('')
  let query = ''
  let controller: AbortController | undefined
  let generation = 0
  // Counted apart from the pages, so paging neither waits for nor cancels it.
  let counter: AbortController | undefined
  let counting = 0
  /**
   * Count the query's results beside its first page. A failed count shows
   * none, the list is whole without it. `keep` leaves the last count on
   * screen until the new one is in.
   */
  async function count(params: string, keep = false) {
    counter?.abort()
    counter = new AbortController()
    const version = ++counting
    if (!keep) total.value = undefined
    try {
      const counted = await readCount(request(params), counter.signal)
      if (version === counting) total.value = counted.count
    } catch {
      if (version === counting) total.value = undefined
    }
  }
  async function load(params: string, append = false) {
    if (append && (loading.value || !next.value)) return
    controller?.abort()
    controller = new AbortController()
    const version = ++generation
    loading.value = true
    refreshing.value = false
    error.value = ''
    if (!append) {
      items.value = []
      next.value = ''
      totalStorageBytes.value = undefined
    }
    query = params
    try {
      const pending = page(params, append ? next.value : '', controller.signal)
      // Beside the first page, never in its way.
      if (!append) void count(params)
      const p = await pending
      if (version !== generation) return
      items.value = append ? [...items.value, ...p.items] : p.items
      next.value = p.next_cursor || ''
      totalStorageBytes.value = p.total_storage_bytes
    } catch (e) {
      if (
        version === generation &&
        (!(e instanceof DOMException) || e.name !== 'AbortError')
      )
        error.value = errorText(e)
    } finally {
      if (version === generation) loading.value = false
    }
  }
  /**
   * Reload the current query without clearing the list, covering as many items
   * as are already shown so the reader keeps their place.
   */
  async function refresh() {
    controller?.abort()
    controller = new AbortController()
    const signal = controller.signal
    const version = ++generation
    // A superseded load can no longer finish on its own.
    loading.value = false
    refreshing.value = true
    const wanted = Math.max(items.value.length, 1)
    void count(query, true)
    try {
      let collected: Collection[] = []
      let cursor = ''
      let storage: number | undefined
      // Bounded: a long scrolled list refreshes its first pages only.
      for (let n = 0; n < 10; n++) {
        const p = await page(query, cursor, signal)
        if (version !== generation) return
        collected = [...collected, ...p.items]
        cursor = p.next_cursor || ''
        if (n === 0) storage = p.total_storage_bytes
        if (!cursor || collected.length >= wanted) break
      }
      items.value = collected
      next.value = cursor
      totalStorageBytes.value = storage
      error.value = ''
    } catch (e) {
      if (
        version === generation &&
        (!(e instanceof DOMException) || e.name !== 'AbortError')
      )
        error.value = errorText(e)
    } finally {
      if (version === generation) refreshing.value = false
    }
  }
  onUnmounted(() => {
    controller?.abort()
    counter?.abort()
  })
  return {
    items,
    totalStorageBytes,
    total,
    next,
    loading,
    refreshing,
    error,
    load,
    refresh,
    more: () => load(query, true),
    remove: (id: string) => {
      const kept = items.value.filter((a) => a.id !== id)
      if (kept.length < items.value.length && total.value)
        total.value = total.value - 1
      items.value = kept
    },
  }
}
