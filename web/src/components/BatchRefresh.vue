<script setup vapor lang="ts">
import { computed, onUnmounted, shallowRef, useTemplateRef, watch } from 'vue'
import { api, errorText, type RefreshBatch, type UpdateMode } from '../api'
const props = defineProps<{
  selected: string[]
  /** Every collection currently listed, for selecting them all at once. */
  listed: string[]
}>()
const emit = defineEmits<{
  select: [ids: string[]]
  close: []
  finished: []
}>()
const modes: { value: UpdateMode; label: string; description: string }[] = [
  {
    value: 'append',
    label: '附加更新',
    description: '只抓新增和有改动的内容',
  },
  {
    value: 'full',
    label: '完整更新',
    description: '全部重新抓取',
  },
]
const choosing = shallowRef(false)
const busy = shallowRef(false)
const error = shallowRef('')
const batch = shallowRef<RefreshBatch>()
const dialog = useTemplateRef<HTMLDialogElement>('sheet')
watch(choosing, (open) => {
  if (open) dialog.value?.showModal()
  else dialog.value?.close()
})
const allSelected = computed(
  () =>
    props.listed.length > 0 &&
    props.listed.every((id) => props.selected.includes(id)),
)
const done = computed(
  () =>
    !!batch.value &&
    batch.value.state !== 'running' &&
    batch.value.running === 0,
)
const progress = computed(() => {
  const b = batch.value
  if (!b) return ''
  if (b.state === 'failed')
    return `已中止：${b.error === 'storage quota exceeded' ? '存储空间不足' : '采集服务不可用'}`
  if (!done.value) return `更新中 ${b.submitted}/${b.total}`
  const counts = [
    ['已抓取', Math.max(b.complete - b.reused, 0)],
    ['无变化', b.reused],
    ['不完整', b.partial],
    ['失败', b.failed],
    ['无法更新', b.rejected],
  ] as const
  return `完成${counts
    .filter(([, n]) => n)
    .map(([label, n], i) => `${i ? ' · ' : '：'}${label} ${n}`)
    .join('')}`
})
let timer: ReturnType<typeof setTimeout> | undefined
let disposed = false
onUnmounted(() => {
  disposed = true
  clearTimeout(timer)
})
async function poll(id: string) {
  try {
    batch.value = await api<RefreshBatch>(`/refresh-batches/${id}`)
  } catch (e) {
    error.value = errorText(e)
  }
  if (disposed) return
  if (done.value) emit('finished')
  else timer = setTimeout(() => poll(id), 2000)
}
async function start(mode: UpdateMode) {
  busy.value = true
  error.value = ''
  try {
    batch.value = await api<RefreshBatch>('/refresh-batches', {
      method: 'POST',
      body: JSON.stringify({
        collection_ids: props.selected,
        update_mode: mode,
      }),
    })
    choosing.value = false
    timer = setTimeout(() => poll(batch.value!.id), 1000)
  } catch (e) {
    error.value = errorText(e)
  } finally {
    busy.value = false
  }
}
function backdrop(event: MouseEvent) {
  if (event.target === dialog.value) choosing.value = false
}
</script>

<template>
  <div class="toolbar" role="region" aria-label="批量更新">
    <template v-if="batch">
      <p class="status" role="status">{{ progress }}</p>
      <button type="button" class="action strong" @click="$emit('close')">
        {{ done ? '完成' : '收起' }}
      </button>
    </template>
    <template v-else>
      <button
        type="button"
        class="action"
        :disabled="!listed.length"
        @click="$emit('select', allSelected ? [] : listed)"
      >
        {{ allSelected ? '取消全选' : '全选' }}
      </button>
      <p class="status">已选 {{ selected.length }} 项</p>
      <button type="button" class="action" @click="$emit('close')">取消</button>
      <button
        type="button"
        class="action strong"
        :disabled="!selected.length"
        @click="choosing = true"
      >
        更新
      </button>
    </template>
  </div>
  <p v-if="error && !choosing" class="error" role="alert">{{ error }}</p>
  <dialog
    ref="sheet"
    class="sheet"
    aria-labelledby="batch-title"
    @click="backdrop"
    @cancel.prevent="choosing = false"
  >
    <div class="group">
      <p class="head">
        <strong id="batch-title">更新 {{ selected.length }} 项收藏</strong>
      </p>
      <button
        v-for="mode in modes"
        :key="mode.value"
        type="button"
        class="mode"
        :disabled="busy"
        @click="start(mode.value)"
      >
        <span class="mode-label">{{ mode.label }}</span
        ><span class="mode-description">{{ mode.description }}</span>
      </button>
      <p v-if="error" class="sheet-error" role="alert">{{ error }}</p>
    </div>
    <button type="button" class="group cancel" @click="choosing = false">
      取消
    </button>
  </dialog>
</template>

<style scoped>
.toolbar {
  position: sticky;
  bottom: max(8px, env(safe-area-inset-bottom));
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 0 var(--gutter);
  padding: 4px 8px;
  border-radius: var(--radius);
  background: var(--card);
  box-shadow:
    0 0 0 1px var(--separator),
    0 4px 16px rgba(0, 0, 0, 0.12);
}
.status {
  flex: 1;
  min-width: 0;
  margin: 0;
  padding: 0 6px;
  font-size: 14px;
  line-height: 1.4;
  color: var(--subtle);
}
.action {
  min-height: 44px;
  padding: 0 10px;
  border-radius: 8px;
  font-size: 15px;
  color: var(--link);
  white-space: nowrap;
}
.action.strong {
  font-weight: 600;
}
.action:disabled {
  color: var(--subtle);
}
.action:active:not(:disabled) {
  background: var(--fill);
}
.error {
  margin: 8px calc(var(--gutter) + 4px) 0;
  font-size: 13px;
  color: var(--destructive);
}
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
  margin-top: 8px;
  border-radius: 14px;
  background: var(--card);
  overflow: hidden;
}
.head {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 16px;
  text-align: center;
  font-size: 14px;
  line-height: 1.5;
  color: var(--subtle);
}
.head strong {
  font-size: 16px;
  color: var(--text);
}
.mode {
  display: grid;
  gap: 2px;
  width: 100%;
  padding: 12px 16px;
  text-align: left;
  box-shadow: inset 0 1px 0 var(--separator);
}
.mode:active:not(:disabled) {
  background: var(--fill);
}
.mode-label {
  font-size: 17px;
  color: var(--link);
}
.mode-description {
  font-size: 13px;
  line-height: 1.5;
  color: var(--subtle);
}
.sheet-error {
  margin: 0;
  padding: 10px 16px;
  font-size: 13px;
  color: var(--destructive);
  box-shadow: inset 0 1px 0 var(--separator);
}
.cancel {
  display: block;
  text-align: center;
  min-height: 52px;
  font-size: 17px;
  font-weight: 600;
  color: var(--link);
}
</style>
