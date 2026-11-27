<script setup vapor lang="ts">
import { useId, useTemplateRef, watch } from 'vue'
import { showSheet } from '../../sheet-focus'
/**
 * The frame every sheet and dialog shares (not the viewer, nor the action
 * menu). Below 700px a sheet rising from the bottom: the title over the
 * content, the actions as full-width rows, and 取消 in a group of its own.
 * From 700px (layout.ts) a dialog in the middle of the window, as a desktop
 * app has it: a raised surface over the page left as it is, the title on
 * the left with a ✕ on the right in 取消's place, and the actions as
 * buttons at the bottom right.
 *
 * The `actions` slot holds the buttons, each with the class `action`, and
 * `primary` for the one the dialog is for (filled from 700px; with
 * `destructive` red-filled) or `destructive` alone for a red secondary one,
 * which goes to the left. Opened through `showSheet`, so focus starts where
 * the last input wants it; the ✕ comes last in the document, so it is
 * never the first control.
 */
const props = withDefaults(
  defineProps<{
    open: boolean
    title: string
    description?: string
    /** While it works: neither Esc nor ✕ nor 取消 closes it. */
    busy?: boolean
    /**
     * Unsaved edits, or something not to lose: a click outside does not
     * close it (Esc, ✕ and 取消 still do).
     */
    dirty?: boolean
    /** A form: the panel is the `<form>`, and `submit` its submission. */
    form?: boolean
    /** Wider from 700px (560px rather than 480px), for forms with rows. */
    wide?: boolean
    /** 取消's words in the sheet: 关闭, 完成. */
    cancelLabel?: string
    /**
     * A panel with a header of its own on every width (采集账号): the ✕
     * shows on phones too, with no 取消 under it.
     */
    page?: boolean
  }>(),
  { cancelLabel: '取消' },
)
const emit = defineEmits<{ cancel: []; submit: [] }>()
const titleId = useId()
const dialog = useTemplateRef<HTMLDialogElement>('sheet')
watch(
  [() => props.open, dialog],
  ([open, el]) => {
    if (!el) return
    if (open && !el.open) showSheet(el)
    else if (!open && el.open) el.close()
  },
  { immediate: true },
)
function cancel() {
  if (!props.busy) emit('cancel')
}
/**
 * A press that starts and ends outside the panel. One that starts inside
 * (selecting text in a field and letting go outside) is not a click outside.
 */
let pressedOutside = false
function pressed(event: PointerEvent) {
  pressedOutside = event.target === dialog.value
}
function clicked(event: MouseEvent) {
  const outside = event.target === dialog.value && pressedOutside
  pressedOutside = false
  if (outside && !props.dirty) cancel()
}
</script>

<template>
  <dialog
    ref="sheet"
    class="sheet sheet-dialog"
    :class="{ 'sheet-wide': wide, 'sheet-page': page }"
    :aria-labelledby="titleId"
    @pointerdown="pressed"
    @click="clicked"
    @cancel.prevent="cancel"
  >
    <component
      :is="form ? 'form' : 'div'"
      class="sheet-group sheet-panel"
      @submit.prevent="emit('submit')"
    >
      <header class="sheet-head">
        <p :id="titleId" class="sheet-title">{{ title }}</p>
        <p v-if="description" class="sheet-description">{{ description }}</p>
      </header>
      <div class="sheet-body"><slot /></div>
      <div v-if="$slots.actions" class="sheet-actions">
        <slot name="actions" />
      </div>
      <button
        type="button"
        class="sheet-close"
        aria-label="关闭"
        title="关闭"
        :disabled="busy"
        @click="cancel"
      >
        <svg
          viewBox="0 0 24 24"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      </button>
    </component>
    <button
      v-if="!page"
      type="button"
      class="sheet-group sheet-cancel"
      :disabled="busy"
      @click="cancel"
    >
      {{ cancelLabel }}
    </button>
  </dialog>
</template>

<style>
/* Shared by every sheet (see the script); not scoped, so the content each
   one slots in (`.action`, `.primary`, `.destructive`) is styled here. */

/* Phones: a sheet from the bottom edge, as iOS's action sheets. */
dialog.sheet-dialog {
  width: 100%;
  max-width: 480px;
  max-height: calc(100dvh - 16px);
  margin: auto auto 0;
  padding: 0 8px max(8px, env(safe-area-inset-bottom));
  border: 0;
  background: none;
  color: var(--text);
  overflow-y: auto;
}
dialog.sheet-dialog:not([open]) {
  display: none;
}
dialog.sheet-dialog::backdrop {
  background: rgba(0, 0, 0, 0.4);
}
.sheet-group {
  display: block;
  width: 100%;
  margin-top: 8px;
  border-radius: 14px;
  background: var(--card);
  overflow: hidden;
}
.sheet-head {
  display: grid;
  gap: 4px;
  padding: 16px 16px 4px;
  text-align: center;
}
.sheet-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.sheet-description {
  margin: 0;
  font-size: 14px;
  line-height: 1.5;
  color: var(--subtle);
  overflow-wrap: anywhere;
}
.sheet-actions {
  margin-top: 12px;
}
.sheet-actions > .action,
.sheet-cancel {
  display: block;
  width: 100%;
  min-height: 52px;
  font-size: 17px;
  text-align: center;
  color: var(--link);
  box-shadow: inset 0 1px 0 var(--separator);
}
.sheet-actions > .action:disabled {
  color: var(--subtle);
  opacity: 1;
}
.sheet-actions > .primary:not(.destructive) {
  font-weight: 600;
}
.sheet-actions > .destructive {
  color: var(--destructive);
}
.sheet-cancel {
  font-weight: 600;
  box-shadow: none;
}
.sheet-close {
  display: none;
}
/* 采集账号: a page in a panel, its header kept in view as it scrolls. */
dialog.sheet-page {
  max-width: 560px;
}
.sheet-page .sheet-panel {
  position: relative;
  padding: 0 0 8px;
  background: var(--page);
  overflow: visible;
}
.sheet-page .sheet-head {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 18px 56px 18px calc(var(--gutter) + 4px);
  border-radius: 14px 14px 0 0;
  background: var(--page);
  text-align: left;
}
.sheet-page .sheet-title {
  font-size: 17px;
  font-weight: 700;
}
.sheet-page .sheet-close {
  position: absolute;
  top: 10px;
  right: 8px;
  z-index: 2;
}

/* From the rail's width up: a dialog in the middle of the window. The page
   under it stays as it is, neither dimmed nor blurred, so the surface is
   set apart by its own colour, a hairline and a shadow. */
@media (min-width: 700px) {
  dialog.sheet-dialog {
    --card: var(--raised);
    --fill: var(--raised-fill);
    width: calc(100vw - 48px);
    max-width: 480px;
    max-height: calc(100dvh - 64px);
    padding: 0;
    border: 1px solid var(--raised-border);
    border-radius: 14px;
    background: var(--raised);
    box-shadow: var(--raised-shadow);
    overflow: hidden;
  }
  dialog.sheet-dialog[open] {
    display: flex;
    flex-direction: column;
    margin: auto;
  }
  dialog.sheet-wide,
  dialog.sheet-page {
    max-width: 560px;
  }
  dialog.sheet-dialog::backdrop {
    background: transparent;
  }
  .sheet-panel {
    position: relative;
    display: flex;
    flex-direction: column;
    min-height: 0;
    margin: 0;
    border-radius: 0;
    background: none;
  }
  .sheet-head {
    flex: none;
    padding: 18px 60px 8px 16px;
    text-align: left;
  }
  .sheet-title {
    font-size: 18px;
    font-weight: 700;
  }
  /* The content scrolls between the title and the buttons. */
  .sheet-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
  }
  .sheet-actions {
    display: flex;
    flex: none;
    flex-direction: row-reverse;
    flex-wrap: wrap;
    gap: 8px;
    margin: 0;
    padding: 14px 16px 16px;
  }
  .sheet-actions > .action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: auto;
    min-width: 80px;
    min-height: 36px;
    margin: 0;
    padding: 0 16px;
    border: 1px solid var(--raised-border);
    border-radius: 8px;
    background: var(--raised);
    color: var(--text);
    font-size: 14px;
    font-weight: 600;
    box-shadow: none;
    transition: background 120ms ease;
  }
  .sheet-actions > .action:hover:not(:disabled) {
    background: var(--raised-fill);
  }
  .sheet-actions > .action:disabled {
    color: var(--text);
    opacity: 0.45;
  }
  .sheet-actions > .primary {
    border-color: transparent;
    background: var(--primary-fill);
    color: #fff;
  }
  .sheet-actions > .primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--primary-fill) 88%, #000);
  }
  .sheet-actions > .primary:disabled {
    color: #fff;
  }
  /* Red: filled when it is what the dialog is for, else red words on the
     left, away from the others. */
  .sheet-actions > .destructive {
    color: var(--destructive);
  }
  .sheet-actions > .destructive:not(.primary) {
    margin-right: auto;
  }
  .sheet-actions > .destructive.primary {
    background: var(--destructive-fill);
    color: #fff;
  }
  .sheet-actions > .destructive.primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--destructive-fill) 88%, #000);
  }
  .sheet-cancel {
    display: none;
  }
  .sheet-close,
  .sheet-page .sheet-close {
    position: absolute;
    top: 12px;
    right: 12px;
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    color: var(--subtle);
  }
  .sheet-close:hover:not(:disabled) {
    background: var(--raised-fill);
    color: var(--text);
  }
  .sheet-page .sheet-panel {
    overflow: hidden;
    padding: 0;
    background: var(--page);
  }
  .sheet-page .sheet-head {
    position: static;
    padding: 18px 60px 8px 16px;
    border-radius: 0;
  }
  .sheet-page .sheet-body {
    padding-bottom: 8px;
  }
  dialog.sheet-page {
    background: var(--page);
  }
}
@media (max-width: 699.98px) {
  .sheet-page .sheet-close {
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    color: var(--subtle);
  }
}
@media (prefers-reduced-motion: reduce) {
  .sheet-actions > .action {
    transition: none;
  }
}
</style>
