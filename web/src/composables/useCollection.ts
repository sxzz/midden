import { onUnmounted, shallowRef } from 'vue'
import { api, errorText, type Collection, type Page } from '../api'
export function useCollection() {
  const items = shallowRef<Collection[]>([])
  const next = shallowRef('')
  const totalStorageBytes = shallowRef<number>()
  const loading = shallowRef(false)
  /** A soft refresh is running; the current items stay on screen meanwhile. */
  const refreshing = shallowRef(false)
  const error = shallowRef('')
  let query = ''
  let controller: AbortController | undefined
  let generation = 0
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
      const p = await page(params, append ? next.value : '', controller.signal)
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
  function page(params: string, cursor: string, signal: AbortSignal) {
    const q = new URLSearchParams(params)
    if (!q.has('entity_type')) q.set('entity_type', 'x.post,instagram.post')
    q.set('q', q.get('q') || '')
    if (cursor) q.set('cursor', cursor)
    return api<Page<Collection>>(`/collections?${q}`, { signal })
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
  onUnmounted(() => controller?.abort())
  return {
    items,
    totalStorageBytes,
    next,
    loading,
    refreshing,
    error,
    load,
    refresh,
    more: () => load(query, true),
    remove: (id: string) => {
      items.value = items.value.filter((a) => a.id !== id)
    },
  }
}
