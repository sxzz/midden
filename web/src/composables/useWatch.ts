import { computed, onActivated, shallowRef, watch as watchSource } from 'vue'
import { call, client, type Watch, type WatchTarget } from '../api'
import { everyText, nextRunText } from '../watches'

/**
 * A profile's or a folder's watch (定期更新), for the row that opens its
 * sheet: none until loaded, or while there is no target.
 */
export function useWatch(target: () => WatchTarget | undefined) {
  const current = shallowRef<Watch>()
  let request = 0
  async function load() {
    const n = ++request
    const t = target()
    current.value = undefined
    if (!t) return
    try {
      const found = await call(
        client.watches.$get({ query: { target: t.target, id: t.id } }),
      )
      if (n === request) current.value = found.items[0]
    } catch {
      // The row reads as not watched; the sheet says what failed.
    }
  }
  watchSource(() => target()?.id, load, { immediate: true })
  // Back on a kept page: its next run may have moved meanwhile.
  onActivated(load)
  /** How often it runs, or nothing when it is not watched. */
  const trailing = computed(() => {
    const w = current.value
    if (!w) return
    return w.enabled ? everyText(w.every) : '已关闭'
  })
  /** When it runs next. */
  const hint = computed(() =>
    current.value?.enabled ? nextRunText(current.value) : undefined,
  )
  function changed(w: Watch | undefined) {
    ++request
    current.value = w
  }
  return { current, trailing, hint, load, changed }
}
