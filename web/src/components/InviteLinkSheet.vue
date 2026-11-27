<script setup vapor lang="ts">
import { useClipboard } from '@vueuse/core'
import { useTemplateRef } from 'vue'
import { toast } from '../composables/useToast'
import SheetDialog from './ui/SheetDialog.vue'

// An invite still good: its link, shown again whenever asked, and making
// it again. `url` is null for an invite whose token the server did not
// keep (made before it kept them); making it again gives one.
defineProps<{ open: boolean; title: string; url: string | null }>()
const emit = defineEmits<{ done: []; regenerate: [] }>()
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
  <SheetDialog
    :open="open"
    :title="title"
    description="7天内有效，只能用一次。"
    cancel-label="完成"
    @cancel="emit('done')"
  >
    <label v-if="url" class="field">
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
      <button
        v-if="url"
        type="button"
        class="action primary"
        @click="copy(url)"
      >
        复制链接
      </button>
      <button type="button" class="action" @click="emit('regenerate')">
        重新生成
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
