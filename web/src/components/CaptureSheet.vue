<script setup vapor lang="ts">
import { computed, shallowRef, useId, useTemplateRef, watch } from 'vue'
import { defaultOptions, type Options } from '../capture-options'
import { submitLinks } from '../capture-submit'
import { extractLinks } from '../captures'
import { toast } from '../composables/useToast'
import CaptureOptions from './CaptureOptions.vue'
import AppLink from './ui/AppLink.vue'
// 抓取 from the desktop rail: the 采集 page's link box, over whatever page is
// open, so capturing a link does not leave it. Progress is on 采集.
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()
const titleId = useId()
const dialog = useTemplateRef<HTMLDialogElement>('sheet')
const field = useTemplateRef<HTMLTextAreaElement>('field')
const text = shallowRef('')
const options = shallowRef<Options>(defaultOptions())
const submitting = shallowRef(false)
const notice = shallowRef<{ text: string; failed?: boolean }>()
const links = computed(() => extractLinks(text.value))
watch(
  () => props.open,
  (open) => {
    if (open) {
      // The defaults each time, as everywhere a capture starts.
      options.value = defaultOptions()
      notice.value = undefined
      dialog.value?.showModal()
      field.value?.focus()
    } else dialog.value?.close()
  },
)
async function submit() {
  const targets = links.value
  if (!targets.length || submitting.value) return
  submitting.value = true
  notice.value = undefined
  const result = await submitLinks(targets, options.value)
  submitting.value = false
  // What could not be submitted stays in the box to correct or send again.
  text.value = result.failed.join('\n')
  if (result.failed.length) notice.value = result.notice
  else {
    toast(result.notice.text)
    emit('close')
  }
}
function backdrop(event: MouseEvent) {
  if (event.target === dialog.value) emit('close')
}
</script>

<template>
  <dialog
    ref="sheet"
    class="sheet"
    :aria-labelledby="titleId"
    @click="backdrop"
    @cancel.prevent="emit('close')"
  >
    <form class="group" @submit.prevent="submit">
      <p :id="titleId" class="title">采集链接</p>
      <label class="field">
        <span class="sr">链接</span>
        <textarea
          ref="field"
          v-model="text"
          rows="3"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          placeholder="粘贴链接，可多条"
          @keydown.enter.meta.prevent="submit"
          @keydown.enter.ctrl.prevent="submit"
        />
      </label>
      <CaptureOptions v-model="options" collapsible />
      <p
        v-if="notice"
        class="notice"
        :class="{ failed: notice.failed }"
        :role="notice.failed ? 'alert' : 'status'"
      >
        {{ notice.text }}
      </p>
      <button
        type="submit"
        class="action strong"
        :disabled="submitting || !links.length"
      >
        {{
          submitting
            ? '正在提交…'
            : links.length > 1
              ? `采集 ${links.length} 条`
              : '采集'
        }}
      </button>
      <AppLink
        class="action records"
        :to="{ name: 'captures' }"
        @navigate="emit('close')"
        >采集记录</AppLink
      >
    </form>
    <button type="button" class="group action cancel" @click="emit('close')">
      取消
    </button>
  </dialog>
</template>

<style scoped>
.sheet {
  width: 100%;
  max-width: 480px;
  max-height: calc(100dvh - 16px);
  margin: auto auto 0;
  padding: 0 8px max(8px, env(safe-area-inset-bottom));
  border: 0;
  background: none;
  color: var(--text);
  overflow-y: auto;
}
.sheet:not([open]) {
  display: none;
}
.sheet::backdrop {
  background: rgba(0, 0, 0, 0.4);
}
.group {
  display: block;
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
  font-weight: 600;
  line-height: 1.5;
}
.field {
  display: block;
  padding: 10px var(--inset) 12px;
}
.sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
textarea {
  display: block;
  width: 100%;
  min-height: 82px;
  padding: 11px 13px;
  border: 0;
  border-radius: 12px;
  background: var(--fill);
  line-height: 1.55;
  font-size: 14px;
  resize: vertical;
  word-break: break-all;
}
textarea::placeholder {
  color: var(--subtle);
}
.notice {
  margin: 0;
  padding: 0 var(--inset) 12px;
  font-size: 14px;
  line-height: 1.5;
  color: var(--subtle);
}
.notice.failed {
  color: var(--destructive);
}
.action {
  display: block;
  width: 100%;
  min-height: 52px;
  padding: 14px var(--inset);
  font-size: 17px;
  line-height: 24px;
  text-align: center;
  color: var(--link);
  box-shadow: inset 0 1px 0 var(--separator);
}
.action:disabled {
  color: var(--subtle);
}
.strong {
  font-weight: 600;
}
.records {
  font-size: 15px;
}
.cancel {
  font-weight: 600;
  box-shadow: none;
}
.action:active:not(:disabled) {
  background: var(--fill);
}
</style>
