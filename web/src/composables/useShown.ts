import { onActivated, onDeactivated, onMounted, onUnmounted } from 'vue'

/**
 * Run `show` whenever the component comes on screen and `hide` when it
 * goes: mounted or shown again from the page cache (KeepAlive), hidden in
 * the cache or unmounted. `onActivated` alone misses a component mounted
 * inside a page that was already on screen, as a section of 设置 opened in
 * place; this covers both, once each.
 */
export function onShown(show: () => void, hide?: () => void) {
  let shown = false
  const enter = () => {
    if (shown) return
    shown = true
    show()
  }
  const leave = () => {
    if (!shown) return
    shown = false
    hide?.()
  }
  onMounted(enter)
  onActivated(enter)
  onDeactivated(leave)
  onUnmounted(leave)
}
