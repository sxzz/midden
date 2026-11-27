<script setup vapor lang="ts">
import { shallowRef, watch } from 'vue'
import SheetDialog from './ui/SheetDialog.vue'
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
const credential = shallowRef('')
const label = shallowRef('')
watch(
  () => props.open,
  (open) => {
    if (open) {
      credential.value = ''
      label.value = ''
    }
  },
)
function submit() {
  const value = credential.value.trim()
  if (value && !props.busy) emit('submit', value, label.value.trim())
}
</script>

<template>
  <SheetDialog
    :open="open"
    :title="`添加 ${name} 账号`"
    :description="help"
    :busy="busy"
    :dirty="!!(credential.trim() || label.trim())"
    form
    wide
    @cancel="emit('cancel')"
    @submit="submit"
  >
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
    <template #actions>
      <button
        type="submit"
        class="action primary"
        :disabled="busy || !credential.trim()"
      >
        {{ busy ? '正在验证…' : '验证并添加' }}
      </button>
    </template>
  </SheetDialog>
</template>

<style scoped>
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
</style>
