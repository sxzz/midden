<script setup vapor lang="ts">
import { shallowRef, useId, useTemplateRef, watch } from 'vue'
const props = defineProps<{
  open: boolean
  title: string
  confirmLabel: string
  /** The name the field starts with, such as the folder's current one. */
  name?: string
  placeholder?: string
  busy?: boolean
  error?: string
}>()
const emit = defineEmits<{ submit: [name: string]; cancel: [] }>()
const titleId = useId()
const dialog = useTemplateRef<HTMLDialogElement>('sheet')
const value = shallowRef('')
watch(
  () => props.open,
  (open) => {
    if (open) {
      value.value = props.name ?? ''
      dialog.value?.showModal()
    } else dialog.value?.close()
  },
)
function backdrop(event: MouseEvent) {
  if (event.target === dialog.value && !props.busy) emit('cancel')
}
function submit() {
  const name = value.value.trim()
  if (name && !props.busy) emit('submit', name)
}
</script>

<template>
  <dialog
    ref="sheet"
    class="sheet"
    :aria-labelledby="titleId"
    @click="backdrop"
    @cancel.prevent="busy || emit('cancel')"
  >
    <form class="group" @submit.prevent="submit">
      <p :id="titleId" class="title">{{ title }}</p>
      <label class="field">
        <span class="visually-hidden">名称</span>
        <input
          v-model="value"
          maxlength="64"
          autocomplete="off"
          :placeholder="placeholder ?? '收藏夹名称'"
          enterkeyhint="done"
        />
      </label>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <button type="submit" class="action" :disabled="busy || !value.trim()">
        {{ confirmLabel }}
      </button>
    </form>
    <button
      type="button"
      class="group action cancel"
      :disabled="busy"
      @click="emit('cancel')"
    >
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
  margin: 8px 0 0;
  border-radius: 14px;
  background: var(--card);
  overflow: hidden;
}
.title {
  margin: 0;
  padding: 16px 16px 4px;
  text-align: center;
  font-size: 16px;
  font-weight: 700;
  line-height: 1.5;
}
.field {
  display: block;
  padding: 12px 16px 0;
}
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
input {
  display: block;
  width: 100%;
  padding: 11px 13px;
  border: 0;
  border-radius: 12px;
  background: var(--fill);
  font-size: 16px;
  line-height: 1.55;
}
input::placeholder {
  color: var(--subtle);
}
.error {
  margin: 0;
  padding: 12px 16px 0;
  font-size: 14px;
  line-height: 1.5;
  color: var(--destructive);
}
.action {
  display: block;
  width: 100%;
  min-height: 52px;
  margin-top: 16px;
  font-size: 17px;
  text-align: center;
  color: var(--link);
  box-shadow: inset 0 1px 0 var(--separator);
}
.action:disabled {
  color: var(--subtle);
}
.cancel {
  margin-top: 8px;
  font-weight: 600;
  box-shadow: none;
}
</style>
