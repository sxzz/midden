import { nextTick, onUnmounted, watch } from 'vue'
import { placeMenu, type Box } from '../action-menu'

/**
 * An element in the top layer (`popover="manual"`, over sticky bars and
 * dialogs), placed against a box as the dropdown menus are (`placeMenu`):
 * under it, or above for want of room, or with a height it scrolls in;
 * kept inside the window sideways. It follows the box while the page
 * scrolls or the window changes size. `outside` hears a press elsewhere.
 */
export function useAnchoredPopover(options: {
  element: () => HTMLElement | null | undefined
  anchor: () => Box | undefined
  shown: () => boolean
  outside?: (event: PointerEvent) => void
}) {
  let open = false
  function place() {
    const el = options.element()
    const box = options.anchor()
    if (!el || !box || !open) return
    el.style.maxHeight = ''
    const spot = placeMenu(
      box,
      { width: el.offsetWidth, height: el.offsetHeight },
      {
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
      },
    )
    el.style.top = `${spot.top}px`
    el.style.left = `${spot.left}px`
    el.style.maxHeight =
      spot.maxHeight === undefined ? '' : `${spot.maxHeight}px`
    el.dataset.side = spot.above ? 'above' : 'below'
  }
  function press(event: PointerEvent) {
    const el = options.element()
    if (el?.contains(event.target as Node)) return
    options.outside?.(event)
  }
  function show() {
    const el = options.element()
    if (!el || open) return
    open = true
    // Browsers without the popover API keep it in the page's flow.
    if (el.showPopover && !el.matches(':popover-open')) el.showPopover()
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, { capture: true, passive: true })
    document.addEventListener('pointerdown', press, { capture: true })
  }
  function hide() {
    if (!open) return
    open = false
    window.removeEventListener('resize', place)
    window.removeEventListener('scroll', place, { capture: true })
    document.removeEventListener('pointerdown', press, true)
    const el = options.element()
    if (el?.hidePopover && el.matches(':popover-open')) el.hidePopover()
  }
  watch(
    options.shown,
    async (shown) => {
      await nextTick()
      if (shown) show()
      else hide()
    },
    { immediate: true },
  )
  onUnmounted(hide)
  return { place }
}
