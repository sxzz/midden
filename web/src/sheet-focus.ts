/**
 * Where focus starts in a sheet or dialog. `showModal` moves it to the first
 * control, which Safari on a touch screen then rings as if a key had moved
 * there; in a confirmation that is the red button. So a sheet opened by a
 * finger or a pen holds focus itself (a screen reader still starts inside
 * it, and Tab reaches the controls), while one opened from the keyboard,
 * or with a mouse, starts on its first control as before. A text field
 * first in the sheet keeps focus either way: it is there to be typed in.
 */

/** What was used last: a key, or the type of the pointer last pressed. */
let input = ''
let tracking = false

/**
 * Starts noting what was used last (main.ts, before anything opens). The
 * click that opens a sheet came from it, as did the one that opened the
 * menu a confirmation follows.
 */
export function trackInput() {
  if (tracking) return
  tracking = true
  addEventListener('pointerdown', (event) => (input = event.pointerType), {
    capture: true,
    passive: true,
  })
  addEventListener('keydown', () => (input = 'keyboard'), {
    capture: true,
    passive: true,
  })
}

/** The pointer last pressed, or `keyboard` when a key came after it. */
export function lastInput() {
  return input
}

/** Whether a sheet opened after `input` keeps focus on its first control. */
export function startsOnControl(input: string) {
  return input !== 'touch' && input !== 'pen'
}

const TEXT = new Set([
  'text',
  'search',
  'url',
  'email',
  'tel',
  'password',
  'number',
])

/** A field there to be typed in, which keeps focus on any input. */
export function isTextField(el: Element | null) {
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled
  return (
    el instanceof HTMLInputElement &&
    !el.readOnly &&
    !el.disabled &&
    TEXT.has(el.type)
  )
}

/** Opens `dialog` as a modal, with focus where the last input wants it. */
export function showSheet(
  dialog: HTMLDialogElement | null | undefined,
  from = input,
) {
  if (!dialog) return
  dialog.showModal()
  if (startsOnControl(from) || isTextField(document.activeElement)) return
  // Focusable by script only, and never ringed (style.css).
  if (!dialog.hasAttribute('tabindex')) dialog.tabIndex = -1
  dialog.focus({ preventScroll: true })
}
