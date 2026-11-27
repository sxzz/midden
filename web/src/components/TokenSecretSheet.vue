<script setup vapor lang="ts">
import { useClipboard } from '@vueuse/core'
import { computed, useTemplateRef } from 'vue'
import { apiAddress } from '../api'
import { toast } from '../composables/useToast'
import SheetDialog from './ui/SheetDialog.vue'

// A token's secret, right after it was made or rolled: the server keeps only
// its digest, so this is the one time it shows.
const props = defineProps<{ open: boolean; title: string; secret: string }>()
const emit = defineEmits<{ done: [] }>()
const field = useTemplateRef<HTMLInputElement>('field')
const handoffField = useTemplateRef<HTMLTextAreaElement>('handoffField')
// What an AI agent needs, in one paste: its guide, the API and the token.
const handoff = computed(
  () =>
    `说明：${location.origin}/agent.md\nAPI地址：${apiAddress()}\n令牌：${props.secret}`,
)
const { copy: write, copied } = useClipboard()
async function copy(
  text: string,
  what: string,
  into: HTMLInputElement | HTMLTextAreaElement | null,
) {
  // Its fallback, execCommand, can throw where it is gone.
  await write(text).catch(() => {})
  if (copied.value) return toast(`已复制${what}`)
  // No clipboard (plain http, some web views): selected, to copy by hand.
  into?.select()
  toast(`请手动复制${what}`)
}
</script>

<template>
  <!-- The secret shows this once: only 完成 or Esc closes it. -->
  <SheetDialog
    :open="open"
    :title="title"
    description="令牌只显示这一次。"
    cancel-label="完成"
    dirty
    @cancel="emit('done')"
  >
    <label class="field">
      <span class="visually-hidden">令牌</span>
      <input
        ref="field"
        :value="secret"
        readonly
        spellcheck="false"
        autocomplete="off"
        @focus="field?.select()"
      />
    </label>
    <label class="field">
      <span class="visually-hidden">给AI agent</span>
      <textarea
        ref="handoffField"
        :value="handoff"
        readonly
        rows="3"
        spellcheck="false"
        @focus="handoffField?.select()"
      />
    </label>
    <template #actions>
      <button
        type="button"
        class="action primary"
        @click="copy(secret, '令牌', field)"
      >
        复制令牌
      </button>
      <button
        type="button"
        class="action"
        @click="copy(handoff, '', handoffField)"
      >
        复制给AI agent
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
input,
textarea {
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
textarea {
  resize: none;
  overflow-wrap: anywhere;
}
</style>
