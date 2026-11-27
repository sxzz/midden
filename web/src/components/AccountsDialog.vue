<script setup vapor lang="ts">
import { useId, useTemplateRef, watch } from 'vue'
import { showSheet } from '../sheet-focus'
import AccountsView from './AccountsView.vue'
// 采集 → 采集账号: the capture accounts over the records, a sheet from the
// bottom on a phone and a dialog in the middle from 700px (style.css). Its
// address is the tab's own with `?dialog=accounts`, so the bot can link to
// it.
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()
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
function backdrop(event: MouseEvent) {
  if (event.target === dialog.value) emit('close')
}
</script>

<template>
  <dialog
    ref="sheet"
    class="sheet"
    :aria-labelledby="titleId"
    @click="backdrop"
    @cancel.prevent="emit('close')"
  >
    <div class="panel">
      <header class="dialog-head">
        <h2 :id="titleId">采集账号</h2>
        <button
          type="button"
          class="close"
          aria-label="关闭"
          title="关闭"
          @click="emit('close')"
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
      </header>
      <!-- Mounted while open, so each opening reads the accounts again. -->
      <AccountsView v-if="open" />
    </div>
  </dialog>
</template>

<style scoped>
.sheet {
  width: 100%;
  max-width: 560px;
  max-height: calc(100dvh - 16px);
  margin: auto auto 0;
  padding: 0 8px max(8px, env(safe-area-inset-bottom));
  border: 0;
  background: none;
  color: var(--text);
  overflow-y: auto;
}
.sheet:not([open]) {
  display: none;
}
.sheet::backdrop {
  background: rgba(0, 0, 0, 0.4);
}
.panel {
  padding: 0 0 8px;
  border-radius: 14px;
  background: var(--page);
}
.dialog-head {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 8px 10px calc(var(--gutter) + 4px);
  border-radius: 14px 14px 0 0;
  background: var(--page);
}
h2 {
  flex: 1;
  margin: 0;
  font-size: 17px;
  font-weight: 700;
}
.close {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  color: var(--subtle);
}
.close:hover {
  background: var(--fill);
}
</style>
