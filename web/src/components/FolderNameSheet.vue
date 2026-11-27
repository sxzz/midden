<script setup vapor lang="ts">
import { shallowRef, watch } from 'vue'
import SheetDialog from './ui/SheetDialog.vue'
const props = defineProps<{
  open: boolean
  title: string
  confirmLabel: string
  /** The name the field starts with, such as the folder's current one. */
  name?: string
  placeholder?: string
  /** What the field holds, for screen readers. */
  label?: string
  maxlength?: number
  /** For an address rather than a name. */
  url?: boolean
  /** For a whole number. */
  numeric?: boolean
  /** For a number with decimals. */
  decimal?: boolean
  busy?: boolean
  error?: string
}>()
const emit = defineEmits<{ submit: [name: string]; cancel: [] }>()
const value = shallowRef('')
watch(
  () => props.open,
  (open) => {
    if (open) value.value = props.name ?? ''
  },
)
function submit() {
  const name = value.value.trim()
  if (name && !props.busy) emit('submit', name)
}
</script>

<template>
  <SheetDialog
    :open="open"
    :title="title"
    :busy="busy"
    :dirty="value.trim() !== (name ?? '').trim()"
    form
    @cancel="emit('cancel')"
    @submit="submit"
  >
    <label class="field">
      <span class="visually-hidden">{{ label ?? '名称' }}</span>
      <input
        v-model="value"
        :maxlength="maxlength ?? 64"
        autocomplete="off"
        :inputmode="
          url ? 'url' : numeric ? 'numeric' : decimal ? 'decimal' : undefined
        "
        :autocapitalize="url ? 'off' : undefined"
        :spellcheck="url ? false : undefined"
        :placeholder="placeholder ?? '收藏夹名称'"
        enterkeyhint="done"
      />
    </label>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <template #actions>
      <button
        type="submit"
        class="action primary"
        :disabled="busy || !value.trim()"
      >
        {{ confirmLabel }}
      </button>
    </template>
  </SheetDialog>
</template>

<style scoped>
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
</style>
