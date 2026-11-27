<script setup vapor lang="ts">
import { computed, onBeforeUnmount, useId, useTemplateRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  openDropdown,
  placeMenu,
  swallowClick,
  trackPointer,
  type MenuOpener,
} from '../../action-menu'
/**
 * A list of actions (see action-menu.ts): opened with a mouse, a dropdown
 * under the button it was opened from, with no title and no 取消; else an
 * action sheet with `label` as its title. The default slot holds the
 * actions, each with the class `action` (and `destructive` for red ones)
 * and the slot's `item` bound on it, which makes it a `menuitem` in the
 * dropdown. A choice closes the dropdown at once, before its own handler
 * runs; the owner closes the sheet.
 */
const props = defineProps<{
  open: boolean
  label: string
  opener?: MenuOpener
}>()
const emit = defineEmits<{ cancel: [] }>()
const titleId = useId()
const dropdown = computed(() => props.opener?.kind === 'dropdown')
const sheet = useTemplateRef<HTMLDialogElement>('sheet')
const menu = useTemplateRef<HTMLDivElement>('menu')
const router = useRouter()
const itemAttrs = { role: 'menuitem', tabindex: -1 }
const noAttrs = {}
trackPointer()

watch(
  () => props.open,
  (open) => {
    if (!open) {
      sheet.value?.close()
      hide()
    } else if (dropdown.value) show()
    else openSheet()
  },
  // After rendering: the element for this opening's kind is in place.
  { flush: 'post' },
)
onBeforeUnmount(hide)

function openSheet() {
  const dialog = sheet.value
  if (!dialog) return
  dialog.showModal()
  // showModal focuses the first action, which some browsers (Safari on
  // touch) then ring as if a key had moved there. Only the keyboard starts
  // on it; otherwise the sheet itself holds focus, and Tab still reaches
  // the actions.
  if (!props.opener?.keyboard) dialog.focus({ preventScroll: true })
}
function backdrop(event: MouseEvent) {
  if (event.target === sheet.value) emit('cancel')
}

let cancelMine: (() => void) | undefined
let stopRouting: (() => void) | undefined
let changes: MutationObserver | undefined

function show() {
  const el = menu.value
  if (!el || el.matches(':popover-open')) return
  // The top layer: over sticky bars and modal dialogs alike.
  el.showPopover()
  place()
  // Only one dropdown is open at a time.
  openDropdown.cancel?.()
  cancelMine = () => emit('cancel')
  openDropdown.cancel = cancelMine
  if (props.opener?.keyboard) items()[0]?.focus({ preventScroll: true })
  else el.focus({ preventScroll: true })
  document.addEventListener('pointerdown', outside, true)
  document.addEventListener('keydown', escape)
  window.addEventListener('resize', place)
  window.addEventListener('scroll', place, { capture: true, passive: true })
  // Actions that appear once something is loaded change its size.
  changes = new MutationObserver(place)
  changes.observe(el, { childList: true, subtree: true, characterData: true })
  stopRouting = router?.afterEach?.(() => emit('cancel'))
}
/** Closes the dropdown, giving focus back to its button if it had it. */
function hide() {
  const el = menu.value
  document.removeEventListener('pointerdown', outside, true)
  document.removeEventListener('keydown', escape)
  window.removeEventListener('resize', place)
  window.removeEventListener('scroll', place, { capture: true })
  changes?.disconnect()
  changes = undefined
  stopRouting?.()
  stopRouting = undefined
  if (cancelMine && openDropdown.cancel === cancelMine)
    openDropdown.cancel = undefined
  cancelMine = undefined
  if (!el?.matches(':popover-open')) return
  const focused = document.activeElement
  const inside = !focused || focused === document.body || el.contains(focused)
  el.hidePopover()
  if (inside) props.opener?.anchor?.focus({ preventScroll: true })
}
function place() {
  const el = menu.value
  const anchor = props.opener?.anchor
  if (!el || !anchor) return
  el.style.maxHeight = ''
  const box = anchor.getBoundingClientRect()
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
  el.style.maxHeight = spot.maxHeight === undefined ? '' : `${spot.maxHeight}px`
  el.dataset.side = spot.above ? 'above' : 'below'
}
// A press outside closes the dropdown and is spent on that: the click it
// ends in does nothing, so a press on the button does not open it again.
function outside(event: PointerEvent) {
  if (menu.value?.contains(event.target as Node)) return
  swallowClick()
  emit('cancel')
}
function escape(event: KeyboardEvent) {
  if (event.key !== 'Escape') return
  event.preventDefault()
  event.stopPropagation()
  emit('cancel')
}
function items() {
  return [
    ...(menu.value?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
  ].filter((item) => !item.matches(':disabled, [aria-disabled="true"]'))
}
function keydown(event: KeyboardEvent) {
  const list = items()
  const at = list.indexOf(document.activeElement as HTMLElement)
  let next: HTMLElement | undefined
  switch (event.key) {
    case 'ArrowDown':
      next = list[(at + 1) % list.length]
      break
    case 'ArrowUp':
      next =
        list[at < 0 ? list.length - 1 : (at - 1 + list.length) % list.length]
      break
    case 'Home':
      next = list[0]
      break
    case 'End':
      next = list.at(-1)
      break
    case ' ':
      // A button chooses on Space by itself; a link does not.
      if (document.activeElement instanceof HTMLAnchorElement) {
        event.preventDefault()
        document.activeElement.click()
      }
      return
    case 'Tab':
      // Focus goes back to the button, and Tab moves on from there.
      hide()
      emit('cancel')
      return
    default:
      return
  }
  event.preventDefault()
  next?.focus()
}
function chose(event: MouseEvent) {
  const item = (event.target as Element).closest('[role="menuitem"]')
  if (item && !item.matches(':disabled, [aria-disabled="true"]')) hide()
}
</script>

<template>
  <div
    v-if="dropdown"
    ref="menu"
    class="dropdown"
    popover="manual"
    role="menu"
    tabindex="-1"
    :aria-label="label"
    @keydown="keydown"
    @click.capture="chose"
  >
    <slot :item="itemAttrs" />
  </div>
  <dialog
    v-else
    ref="sheet"
    class="sheet"
    tabindex="-1"
    :aria-labelledby="titleId"
    @click="backdrop"
    @cancel.prevent="emit('cancel')"
  >
    <div class="group">
      <p :id="titleId" class="title">{{ label }}</p>
      <slot :item="noAttrs" />
    </div>
    <button type="button" class="group action cancel" @click="emit('cancel')">
      取消
    </button>
  </dialog>
</template>

<style scoped>
.sheet {
  width: 100%;
  max-width: 480px;
  margin: auto auto 0;
  padding: 0 8px max(8px, env(safe-area-inset-bottom));
  border: 0;
  background: none;
  color: var(--text);
}
.sheet:not([open]) {
  display: none;
}
.sheet:focus {
  outline: none;
}
.sheet::backdrop {
  background: rgba(0, 0, 0, 0.4);
}
.group {
  width: 100%;
  margin-top: 8px;
  border-radius: 14px;
  background: var(--card);
  overflow: hidden;
}
.title {
  margin: 0;
  padding: 14px 16px;
  text-align: center;
  font-size: 14px;
  line-height: 1.5;
  color: var(--subtle);
  overflow-wrap: anywhere;
}
.sheet :deep(.action) {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: 52px;
  font-size: 17px;
  text-align: center;
  color: var(--link);
  box-shadow: inset 0 1px 0 var(--separator);
}
.sheet .cancel {
  font-weight: 600;
  box-shadow: none;
}

/* X's ⋯ menus: a rounded card with a soft shadow (a glow in the dark),
   left-aligned rows with a faint hover. */
.dropdown {
  position: fixed;
  inset: auto;
  margin: 0;
  min-width: 200px;
  max-width: min(360px, calc(100vw - 16px));
  padding: 0;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  border: 0;
  border-radius: 12px;
  background: var(--card);
  color: var(--text);
  box-shadow:
    0 0 15px color-mix(in srgb, var(--text) 18%, transparent),
    0 0 3px 1px color-mix(in srgb, var(--text) 12%, transparent);
}
.dropdown:focus {
  outline: none;
}
.dropdown :deep(.action) {
  display: block;
  width: 100%;
  padding: 12px 16px;
  font-size: 15px;
  font-weight: 700;
  line-height: 1.33;
  text-align: left;
  color: var(--text);
  transition: background 120ms ease;
}
.dropdown :deep(.action svg) {
  width: 19px;
  height: 19px;
  margin-right: 12px;
  vertical-align: -4px;
}
.dropdown :deep(.action:hover),
.dropdown :deep(.action:focus-visible) {
  background: color-mix(in srgb, var(--text) 5%, transparent);
}
.dropdown :deep(.action:focus-visible) {
  outline: 2px solid var(--link);
  outline-offset: -2px;
  border-radius: 0;
}
.sheet :deep(.destructive),
.dropdown :deep(.destructive) {
  color: var(--destructive);
}
@media (prefers-reduced-motion: reduce) {
  .dropdown :deep(.action) {
    transition: none;
  }
}
</style>
