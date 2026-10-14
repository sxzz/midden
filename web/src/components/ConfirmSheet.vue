<script setup vapor lang="ts">
import { computed, shallowRef, useId, useTemplateRef, watch } from 'vue'
const props = defineProps<{
  open: boolean
  title: string
  description?: string
  confirmLabel: string
  busy?: boolean
  /** For what cannot be undone: the phrase to type before confirming. */
  phrase?: string
}>()
// Several sheets can share a page; each needs its own title id.
const titleId = useId()
const emit = defineEmits<{ confirm: []; cancel: [] }>()
const dialog = useTemplateRef<HTMLDialogElement>('sheet')
watch(
  () => props.open,
  (open) => {
    typed.value = ''
    if (open) dialog.value?.showModal()
    else dialog.value?.close()
  },
)
const typed = shallowRef('')
const ready = computed(
  () => !props.phrase || typed.value.trim() === props.phrase,
)
function backdrop(event: MouseEvent) {
  if (event.target === dialog.value) emit('cancel')
}
</script>

<template>
  <dialog
    ref="sheet"
    class="sheet"
    :aria-labelledby="titleId"
    @click="backdrop"
    @cancel.prevent="$emit('cancel')"
  >
    <div class="group">
      <p class="head">
        <strong :id="titleId">{{ title }}</strong
        ><span v-if="description">{{ description }}</span>
      </p>
      <label v-if="phrase" class="phrase">
        <span>输入「{{ phrase }}」以确认</span>
        <input
          v-model="typed"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          :placeholder="phrase"
        />
      </label>
      <button
        type="button"
        class="action destructive"
        :disabled="busy || !ready"
        @click="ready && $emit('confirm')"
      >
        {{ confirmLabel }}
      </button>
    </div>
    <button type="button" class="group action cancel" @click="$emit('cancel')">
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
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 16px;
  text-align: center;
  font-size: 14px;
  line-height: 1.5;
  color: var(--subtle);
}
.head strong {
  font-size: 16px;
  color: var(--text);
}
.action {
  display: block;
  width: 100%;
  min-height: 52px;
  font-size: 17px;
  text-align: center;
  box-shadow: inset 0 1px 0 var(--separator);
}
.destructive {
  color: var(--destructive);
}
.destructive:disabled {
  color: var(--subtle);
}
.phrase {
  display: grid;
  gap: 8px;
  padding: 0 16px 16px;
  font-size: 14px;
  color: var(--subtle);
  text-align: center;
}
.phrase input {
  width: 100%;
  padding: 10px 12px;
  border: 0;
  border-radius: 10px;
  background: var(--fill);
  font-size: 16px;
  text-align: center;
}
.cancel {
  color: var(--link);
  font-weight: 600;
  box-shadow: none;
}
</style>
