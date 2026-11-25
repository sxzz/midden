import { settleBar } from './tabbar'

/** How long a page may take to grow tall enough for the position. */
const PATIENCE = 3000
const INPUT = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const

let stop = () => {}

/**
 * Scroll the window to `y`. A page whose content is still loading (a detail
 * shown again after the cache let it go, or after a reload) is too short at
 * first: keep scrolling there as it grows, until it gets there, the reader
 * scrolls, another page is restored, or a few seconds pass.
 */
export function restoreScroll(y: number) {
  stop()
  const reached = () => Math.abs(window.scrollY - y) < 2
  // Only a jump the page makes itself keeps the bottom bar where it is.
  const apply = () => {
    if (reached()) return
    settleBar(400)
    window.scrollTo(0, y)
  }
  apply()
  if (reached() || typeof ResizeObserver === 'undefined') return
  const observer = new ResizeObserver(() => {
    apply()
    if (reached()) done()
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  function done() {
    observer.disconnect()
    clearTimeout(timer)
    for (const type of INPUT) removeEventListener(type, done)
    stop = () => {}
  }
  timer = setTimeout(done, PATIENCE)
  stop = done
  observer.observe(document.body)
  for (const type of INPUT) addEventListener(type, done, { passive: true })
}
