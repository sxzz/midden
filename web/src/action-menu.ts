/**
 * A menu of actions (a folder's ⋯, the 多选 bar's ⋯) opens as a dropdown
 * under its button when it is opened with a mouse or trackpad, as X's ⋯
 * menus do, and as an action sheet otherwise. The input decides, not the
 * window's width: an iPad with a trackpad gets the dropdown, a narrow
 * desktop window too, a touch laptop's tap the sheet.
 */
export type MenuKind = 'dropdown' | 'sheet'

/** How a menu was opened: as which kind, under which button, by keyboard. */
export interface MenuOpener {
  kind: MenuKind
  anchor?: HTMLElement
  /** Opened with Enter or Space: the first item takes focus. */
  keyboard: boolean
}

/** The parts of a click that tell what made it. */
export interface Activation {
  /** The click's own pointer, where the browser gives one (`''` from keys). */
  pointerType?: string
  /** How many clicks; 0 when keys or a script made it. */
  detail?: number
}

export const FINE_POINTER = '(pointer: fine)'

/**
 * Which kind of menu a click opens. The click's own `pointerType` decides
 * when it has one (mouse: a dropdown; touch or pen: a sheet). Browsers whose
 * clicks are not pointer events yet still report a real click's count, so
 * the pointer last pressed down stands in. A click from the keyboard has
 * no pointer of its own; then the primary pointer of the device decides
 * (`finePointer`, the `(pointer: fine)` media query at that moment).
 */
export function menuKind(
  click: Activation | undefined,
  lastPointer: string,
  finePointer: boolean,
): MenuKind {
  const type =
    click?.pointerType || ((click?.detail ?? 0) > 0 ? lastPointer : '')
  if (type === 'mouse') return 'dropdown'
  if (type === 'touch' || type === 'pen') return 'sheet'
  return finePointer ? 'dropdown' : 'sheet'
}

let lastPointer = ''
let tracking = false
/** Starts noting the pointer last pressed; a menu does when it is set up. */
export function trackPointer() {
  if (tracking) return
  tracking = true
  addEventListener(
    'pointerdown',
    (event) => (lastPointer = event.pointerType),
    { capture: true, passive: true },
  )
}

/** How the click `event` on a menu's button opens the menu. */
export function menuOpener(event: MouseEvent): MenuOpener {
  const anchor =
    event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined
  const fine = !!globalThis.matchMedia?.(FINE_POINTER).matches
  return {
    kind: menuKind(event as Activation, lastPointer, fine),
    anchor,
    keyboard: event.detail === 0,
  }
}

export interface Box {
  top: number
  right: number
  bottom: number
  left: number
}

export interface Placement {
  top: number
  left: number
  /** Set when the menu is taller than the room: it scrolls inside. */
  maxHeight?: number
  /** Above its button, for want of room below. */
  above: boolean
}

/** Between the button and the menu. */
const GAP = 4
/** Kept free between the menu and the window's edges. */
const EDGE = 8

/**
 * Where a dropdown of `size` goes for a button at `anchor`, in a window of
 * `viewport`: under the button, or above it when only there is room, or
 * on the roomier side with a height it scrolls in. It lines up with the
 * button's left edge, or its right edge when the button is in the right
 * half of the window, and moves sideways to stay inside.
 */
export function placeMenu(
  anchor: Box,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): Placement {
  const below = viewport.height - anchor.bottom - GAP - EDGE
  const over = anchor.top - GAP - EDGE
  let top: number
  let maxHeight: number | undefined
  let above = false
  if (size.height <= below) top = anchor.bottom + GAP
  else if (size.height <= over) {
    top = anchor.top - GAP - size.height
    above = true
  } else if (below >= over) {
    top = anchor.bottom + GAP
    maxHeight = Math.max(below, 0)
  } else {
    maxHeight = Math.max(over, 0)
    top = anchor.top - GAP - maxHeight
    above = true
  }
  const rightHalf = (anchor.left + anchor.right) / 2 > viewport.width / 2
  let left = rightHalf ? anchor.right - size.width : anchor.left
  left = Math.min(left, viewport.width - EDGE - size.width)
  left = Math.max(left, EDGE)
  return { top, left, maxHeight, above }
}

/** The one dropdown open in the page, closed when another one opens. */
export const openDropdown: { cancel?: () => void } = {}

let swallowUntil = 0
let swallowing = false
/**
 * Spends the click that the press under way ends in: a press outside a
 * dropdown only closes it, so a press on its button does not open it again
 * and one on a link does not follow it.
 */
export function swallowClick() {
  swallowUntil = performance.now() + 1000
  if (swallowing) return
  swallowing = true
  addEventListener(
    'click',
    (event) => {
      if (performance.now() > swallowUntil) return
      swallowUntil = 0
      event.preventDefault()
      event.stopPropagation()
    },
    { capture: true },
  )
  // A press that ends in no click (a drag, the scroll bar) spends nothing.
  // On the window, this runs before the press outside asks to swallow.
  addEventListener('pointerdown', () => (swallowUntil = 0), { capture: true })
}
