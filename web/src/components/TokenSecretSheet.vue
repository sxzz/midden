<script setup vapor lang="ts">
import { useId, useTemplateRef, watch } from 'vue'
import { toast } from '../composables/useToast'

// A token's secret, right after it was made or rolled: the server keeps only
// its digest, so this is the one time it shows.
const props = defineProps<{ open: boolean; title: string; secret: string }>()
const emit = defineEmits<{ done: [] }>()
const titleId = useId()
const dialog = useTemplateRef<HTMLDialogElement>('sheet')
const field = useTemplateRef<HTMLInputElement>('field')
watch(
  () => props.open,
  (open) => {
    if (open) dialog.value?.showModal()
    else dialog.value?.close()
  },
)
async function copy() {
  try {
    await navigator.clipboard.writeText(props.secret)
    toast('已复制令牌')
  } catch {
    // Some web views refuse the clipboard; leave it selected instead.
    field.value?.select()
    toast('请手动复制令牌')
  }
}
</script>

<template>
  <dialog
    ref="sheet"
    class="sheet"
    :aria-labelledby="titleId"
    @cancel.prevent="emit('done')"
  >
    <div class="group">
      <p :id="titleId" class="title">{{ title }}</p>
      <p class="note">令牌只显示这一次。</p>
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
      <button type="button" class="action" @click="copy">复制</button>
    </div>
    <button type="button" class="group action done" @click="emit('done')">
      完成
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
  padding: 16px 16px 0;
  text-align: center;
  font-size: 16px;
  font-weight: 700;
  line-height: 1.5;
}
.note {
  margin: 4px 0 0;
  padding: 0 16px;
  text-align: center;
  font-size: 14px;
  color: var(--subtle);
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
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 14px;
  line-height: 1.55;
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
.done {
  margin-top: 8px;
  font-weight: 600;
  box-shadow: none;
}
</style>
