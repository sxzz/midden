<script setup vapor lang="ts">
import { computed, shallowRef, useId, useTemplateRef, watch } from 'vue'
import {
  call,
  client,
  errorText,
  type UpdatePreview,
  type UpdateTarget,
} from '../api'
import { defaultOptions, type Options } from '../capture-options'
import { countText, coverText } from '../captures'
import { toast } from '../composables/useToast'
import CaptureOptions from './CaptureOptions.vue'
import SkeletonBox from './ui/SkeletonBox.vue'
const props = defineProps<{
  open: boolean
  target: UpdateTarget
  /** A single profile's handle, for the title 更新 @foo. */
  label?: string
}>()
const emit = defineEmits<{
  /** The update started; its record shows the progress. */
  started: [recordId: string]
  cancel: []
}>()
/** A list longer than this is skipped by the server (抓关系网). */
const RELATION_LIMIT = 5000
const titleId = useId()
const dialog = useTemplateRef<HTMLDialogElement>('sheet')
const preview = shallowRef<UpdatePreview>()
const loading = shallowRef(false)
const busy = shallowRef(false)
const error = shallowRef('')
/** The defaults each time, as everywhere a capture starts. */
const options = shallowRef<Options>(defaultOptions())
let request = 0
async function load() {
  const current = ++request
  loading.value = true
  error.value = ''
  preview.value = undefined
  try {
    const result = await call(
      client.updates.preview.$post({ json: { target: props.target } }),
    )
    if (current === request) preview.value = result
  } catch (e) {
    if (current === request) error.value = errorText(e)
  } finally {
    if (current === request) loading.value = false
  }
}
watch(
  () => props.open,
  (open) => {
    if (open) {
      options.value = defaultOptions()
      void load()
      dialog.value?.showModal()
    } else {
      ++request
      dialog.value?.close()
    }
  },
)
const title = computed(() => {
  const p = preview.value
  if (props.label) return `更新 ${props.label}`
  if (!p) return '更新'
  return `更新 ${coverText(p.posts, p.profiles)}`
})
/** A single profile's list sizes, and which lists would be skipped. */
const counts = computed(() => {
  const c = preview.value?.counts
  if (!c) return ''
  const sizes = [
    c.following !== undefined && `关注 ${countText(c.following)}`,
    c.followers !== undefined && `粉丝 ${countText(c.followers)}`,
  ]
    .filter(Boolean)
    .join(' · ')
  const skipped = [
    (c.following ?? 0) > RELATION_LIMIT && '关注',
    (c.followers ?? 0) > RELATION_LIMIT && '粉丝',
  ].filter(Boolean)
  return skipped.length
    ? `${sizes}（超过 ${RELATION_LIMIT}，将跳过${skipped.join('和')}名单）`
    : sizes
})
const posts = computed(() => (preview.value?.posts ?? 0) > 0)
const profiles = computed(() => (preview.value?.profiles ?? 0) > 0)
const listable = computed(() => (preview.value?.listable ?? 0) > 0)
async function start() {
  if (busy.value || !preview.value) return
  busy.value = true
  error.value = ''
  try {
    const record = await call(
      client.updates.$post(
        {
          json: {
            target: props.target,
            options: {
              ...options.value,
              relations: listable.value && options.value.relations,
            },
          },
        },
        { headers: { 'Idempotency-Key': crypto.randomUUID() } },
      ),
    )
    toast('已开始更新')
    emit('started', record.id)
  } catch (e) {
    error.value = errorText(e)
  } finally {
    busy.value = false
  }
}
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
    @cancel.prevent="emit('cancel')"
  >
    <div class="group">
      <p :id="titleId" class="head">{{ title }}</p>
      <div
        v-if="loading"
        class="note note-skeleton"
        role="status"
        aria-busy="true"
        aria-label="正在读取要更新的内容"
      >
        <SkeletonBox height="13px" width="64%" />
        <SkeletonBox height="13px" width="48%" />
        <SkeletonBox height="13px" width="56%" />
      </div>
      <CaptureOptions
        v-if="preview"
        v-model="options"
        :profiles="profiles"
        :posts="posts"
        :relations="listable"
        :relations-hint="counts"
        :disabled="busy"
      />
      <p v-if="error" class="note failed" role="alert">{{ error }}</p>
      <button
        type="button"
        class="action strong"
        :disabled="busy || !preview"
        @click="start"
      >
        {{ busy ? '正在开始…' : '开始更新' }}
      </button>
    </div>
    <button type="button" class="group action cancel" @click="emit('cancel')">
      取消
    </button>
  </dialog>
</template>

<style scoped>
/* While the facts load, bars where their lines will be. */
.note-skeleton {
  display: grid;
  gap: 10px;
  padding-top: 12px;
  padding-bottom: 12px;
}
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
  width: 100%;
  margin-top: 8px;
  border-radius: 14px;
  background: var(--card);
  overflow: hidden;
}
.head {
  margin: 0;
  padding: 16px;
  text-align: center;
  font-size: 16px;
  font-weight: 600;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.note {
  margin: 0;
  padding: 10px 16px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--subtle);
  box-shadow: inset 0 1px 0 var(--separator);
}
.note.failed {
  color: var(--destructive);
}
.action {
  display: block;
  width: 100%;
  min-height: 52px;
  font-size: 17px;
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
.cancel {
  color: var(--link);
  box-shadow: none;
}
</style>
