import { onScopeDispose, shallowRef, toValue, type MaybeRefOrGetter } from 'vue'

/** Travel in px before a gesture counts as a horizontal page drag. */
const CLAIM = 8
/** Release speed in px/ms that turns a page even on a short drag. */
const FLING = 0.4
/** Largest share of a page the track may be pulled past either end. */
const RUBBER = 0.4

export interface ImageSwipeOptions {
  /** Number of pages; the first and last ends rubber-band instead of moving. */
  count: MaybeRefOrGetter<number>
  /** Page currently at rest, so we know which ends are boundaries. */
  index: MaybeRefOrGetter<number>
  /** The translated track, measured and also read while it is animating. */
  track: () => HTMLElement | null | undefined
  /** Called with -1 or 1 when a release should turn the page. */
  commit: (delta: number) => void
}

function pointOf(list: TouchList, id: number | undefined) {
  return Array.from(list).find((touch) => touch.identifier === id) ?? list[0]
}

/**
 * Finger-tracking horizontal paging for a `translate3d` track.
 *
 * The gesture is claimed only after the finger clearly moves sideways, so a tap
 * or a long press (the native "save image" menu) is never intercepted, and
 * `preventDefault` runs only on moves we own so pinch-zoom keeps working.
 */
export function useImageSwipe(options: ImageSwipeOptions) {
  /** Pixels the track is displaced from the resting position of `index`. */
  const offset = shallowRef(0)
  /** True while a finger owns the track, so CSS transitions stay off. */
  const dragging = shallowRef(false)
  /** Whether this gesture became a drag, so a tap can be told apart from it. */
  const moved = shallowRef(false)

  let identifier: number | undefined
  let startX = 0
  let startY = 0
  let width = 1
  let origin = 0
  let lastX = 0
  let lastAt = 0
  let claimed = false

  /** Drop the gesture and let the track animate back to its resting place. */
  function settle() {
    identifier = undefined
    claimed = false
    dragging.value = false
    offset.value = 0
  }

  /** Resistance past the first and last page, asymptotic to `RUBBER` pages. */
  function pull(distance: number) {
    const at = toValue(options.index)
    const blocked = distance > 0 ? at === 0 : at >= toValue(options.count) - 1
    if (!blocked) return distance
    const ratio = Math.abs(distance) / width
    return Math.sign(distance) * width * RUBBER * (1 - 1 / (ratio * 2 + 1))
  }

  /** Where the track really sits, so grabbing mid-transition does not jump. */
  function displacement(element: HTMLElement) {
    const { transform } = getComputedStyle(element)
    if (!transform || transform === 'none') return 0
    try {
      const matrix = new DOMMatrixReadOnly(transform)
      return matrix.m41 + toValue(options.index) * width
    } catch {
      return 0
    }
  }

  function start(event: TouchEvent) {
    const element = options.track()
    // A second finger means pinch-zoom: hand the gesture back to the browser.
    if (event.touches.length !== 1 || !element) {
      settle()
      return
    }
    const touch = event.touches[0]
    width = element.getBoundingClientRect().width || 1
    identifier = touch.identifier
    startX = lastX = touch.clientX
    startY = touch.clientY
    lastAt = event.timeStamp
    claimed = false
    moved.value = false
  }

  function claim() {
    const element = options.track()
    origin = element ? displacement(element) : 0
    claimed = true
    moved.value = true
    dragging.value = true
  }

  function drag(event: TouchEvent) {
    if (identifier === undefined) return
    if (event.touches.length !== 1) {
      settle()
      return
    }
    const touch = pointOf(event.touches, identifier)
    const dx = touch.clientX - startX
    const dy = touch.clientY - startY
    if (!claimed) {
      // Vertical intent belongs to the page, not to us.
      if (Math.abs(dy) > CLAIM && Math.abs(dy) >= Math.abs(dx)) {
        identifier = undefined
        return
      }
      if (Math.abs(dx) <= CLAIM) return
      claim()
    }
    // Only moves we own get cancelled, so zoom and long-press stay intact.
    event.preventDefault()
    offset.value = pull(origin + dx)
    lastX = touch.clientX
    lastAt = event.timeStamp
  }

  function end(event: TouchEvent) {
    if (identifier === undefined) return
    const touch = pointOf(event.changedTouches, identifier)
    const dx = touch.clientX - startX
    const travel = Math.abs(dx)
    const speed =
      (touch.clientX - lastX) / Math.max(1, event.timeStamp - lastAt)
    // A tap or a long press never travels, so it never turns the page.
    const horizontal =
      claimed || (travel > CLAIM && travel > Math.abs(touch.clientY - startY))
    const flung = Math.abs(speed) > FLING && travel > CLAIM
    const far = travel > Math.min(72, width * 0.25)
    const delta = (flung ? speed : dx) < 0 ? 1 : -1
    settle()
    if (horizontal && (far || flung)) options.commit(delta)
  }

  const cancel = () => settle()

  // A rotation or resize invalidates the pixel offset currently applied.
  addEventListener('resize', cancel)
  onScopeDispose(() => removeEventListener('resize', cancel))

  return { offset, dragging, moved, start, drag, end, cancel }
}
