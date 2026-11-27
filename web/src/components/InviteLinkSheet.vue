<script setup vapor lang="ts">
import { useClipboard } from '@vueuse/core'
import { useTemplateRef } from 'vue'
import { toast } from '../composables/useToast'
import SheetDialog from './ui/SheetDialog.vue'

// A new invite's link: the server keeps only its token's digest, so this
// is the one time it shows.
defineProps<{ open: boolean; title: string; url: string }>()
const emit = defineEmits<{ done: [] }>()
const field = useTemplateRef<HTMLInputElement>('field')
const { copy: write, copied } = useClipboard()
async function copy(url: string) {
  // Its fallback, execCommand, can throw where it is gone.
  await write(url).catch(() => {})
  if (copied.value) return toast('已复制链接')
  // No clipboard (plain http, some web views): selected, to copy by hand.
  field.value?.select()
  toast('请手动复制链接')
}
</script>

<template>
  <!-- The link shows this once: only 完成 or Esc closes it. -->
  <SheetDialog
    :open="open"
    :title="title"
    description="链接只显示这一次。7天内有效，只能用一次。"
    cancel-label="完成"
    dirty
    @cancel="emit('done')"
  >
    <label class="field">
      <span class="visually-hidden">邀请链接</span>
      <input
        ref="field"
        :value="url"
        readonly
        spellcheck="false"
        autocomplete="off"
        @focus="field?.select()"
      />
    </label>
    <template #actions>
      <button type="button" class="action primary" @click="copy(url)">
        复制链接
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
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 14px;
  line-height: 1.55;
}
</style>
