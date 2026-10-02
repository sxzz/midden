<script setup vapor lang="ts">
import { useTemplateRef, watch } from 'vue'
import type { UpdateMode } from '../api'
const props = defineProps<{ open: boolean; title: string; busy?: boolean }>()
const emit = defineEmits<{ select: [mode: UpdateMode]; cancel: [] }>()
const modes: { value: UpdateMode; label: string; description: string }[] = [
  { value: 'append', label: '附加更新', description: '只抓新增和有改动的内容' },
  { value: 'full', label: '完整更新', description: '全部重新抓取' },
]
const dialog = useTemplateRef<HTMLDialogElement>('sheet')
watch(
  () => props.open,
  (open) => {
    if (open) dialog.value?.showModal()
    else dialog.value?.close()
  },
)
function backdrop(event: MouseEvent) {
  if (event.target === dialog.value) emit('cancel')
}
</script>

<template>
  <dialog
    ref="sheet"
    class="sheet"
    aria-labelledby="update-mode-title"
    @click="backdrop"
    @cancel.prevent="$emit('cancel')"
  >
    <div class="group">
      <p class="head">
        <strong id="update-mode-title">{{ title }}</strong>
      </p>
      <button
        v-for="mode in modes"
        :key="mode.value"
        type="button"
        class="mode"
        :disabled="busy"
        @click="$emit('select', mode.value)"
      >
        <span class="mode-label">{{ mode.label }}</span
        ><span class="mode-description">{{ mode.description }}</span>
      </button>
    </div>
    <button type="button" class="group cancel" @click="$emit('cancel')">
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
.head {
  margin: 0;
  padding: 16px;
  text-align: center;
  font-size: 16px;
  line-height: 1.5;
}
.mode {
  display: grid;
  gap: 2px;
  width: 100%;
  padding: 12px 16px;
  text-align: left;
  box-shadow: inset 0 1px 0 var(--separator);
}
.mode:active:not(:disabled) {
  background: var(--fill);
}
.mode-label {
  font-size: 17px;
  color: var(--link);
}
.mode-description {
  font-size: 13px;
  line-height: 1.5;
  color: var(--subtle);
}
.cancel {
  display: block;
  text-align: center;
  min-height: 52px;
  font-size: 17px;
  font-weight: 600;
  color: var(--link);
}
</style>
