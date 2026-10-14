<script setup vapor lang="ts">
import { shallowRef, useId, useTemplateRef, watch } from 'vue'
const props = defineProps<{
  open: boolean
  /** Platform display name, such as X. */
  name: string
  help?: string
  busy?: boolean
  error?: string
}>()
const emit = defineEmits<{
  submit: [credential: string, name: string]
  cancel: []
}>()
const titleId = useId()
const dialog = useTemplateRef<HTMLDialogElement>('sheet')
const credential = shallowRef('')
const label = shallowRef('')
watch(
  () => props.open,
  (open) => {
    if (open) {
      credential.value = ''
      label.value = ''
      dialog.value?.showModal()
    } else dialog.value?.close()
  },
)
function backdrop(event: MouseEvent) {
  if (event.target === dialog.value && !props.busy) emit('cancel')
}
function submit() {
  const value = credential.value.trim()
  if (value && !props.busy) emit('submit', value, label.value.trim())
}
</script>

<template>
  <dialog
    ref="sheet"
    class="sheet"
    :aria-labelledby="titleId"
    @click="backdrop"
    @cancel.prevent="busy || $emit('cancel')"
  >
    <form class="group" @submit.prevent="submit">
      <p class="head">
        <strong :id="titleId">添加 {{ name }} 账号</strong
        ><span v-if="help">{{ help }}</span>
      </p>
      <label class="field">
        <span class="field-label">凭据</span>
        <textarea
          v-model="credential"
          rows="3"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          placeholder="粘贴凭据"
        />
      </label>
      <label class="field">
        <span class="field-label">名称（可选）</span>
        <input
          v-model="label"
          maxlength="100"
          autocomplete="off"
          placeholder="用于区分多个账号"
        />
      </label>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <button
        type="submit"
        class="action"
        :disabled="busy || !credential.trim()"
      >
        {{ busy ? '正在验证…' : '验证并添加' }}
      </button>
    </form>
    <button
      type="button"
      class="group action cancel"
      :disabled="busy"
      @click="$emit('cancel')"
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
.head {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 16px 16px 4px;
  text-align: center;
  font-size: 14px;
  line-height: 1.5;
  color: var(--subtle);
}
.head strong {
  font-size: 16px;
  color: var(--text);
}
.field {
  display: block;
  padding: 12px 16px 0;
}
.field-label {
  display: block;
  margin-bottom: 8px;
  color: var(--subtle);
  font-size: 13px;
  font-weight: 600;
}
textarea,
input {
  display: block;
  width: 100%;
  padding: 11px 13px;
  border: 0;
  border-radius: 12px;
  background: var(--fill);
  line-height: 1.55;
}
textarea {
  min-height: 82px;
  resize: vertical;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 14px;
  word-break: break-all;
}
textarea::placeholder,
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
