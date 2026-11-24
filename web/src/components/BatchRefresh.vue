<script setup vapor lang="ts">
import { computed, shallowRef } from 'vue'
import { useRouter } from 'vue-router'
import UpdateSheet from './UpdateSheet.vue'
const props = defineProps<{
  selected: string[]
  /** Every collection currently listed, for selecting them all at once. */
  listed: string[]
}>()
const emit = defineEmits<{
  select: [ids: string[]]
  /** The update is running: selection ends, this bar stays to link to it. */
  started: []
  close: []
}>()
const router = useRouter()
const sheet = shallowRef(false)
/** The started update's record and how many it covers. */
const started = shallowRef<{ record: string; count: number }>()
const allSelected = computed(
  () =>
    props.listed.length > 0 &&
    props.listed.every((id) => props.selected.includes(id)),
)
// The update is one record: its page follows the progress, not this bar.
function onStarted(record: string) {
  sheet.value = false
  started.value = { record, count: props.selected.length }
  emit('started')
}
function openRecord() {
  const record = started.value?.record
  emit('close')
  if (record) void router.push({ name: 'capture', params: { id: record } })
}
</script>

<template>
  <div class="toolbar" role="region" aria-label="批量更新">
    <template v-if="started">
      <p class="status" role="status">已开始更新 {{ started.count }} 项</p>
      <button type="button" class="action" @click="emit('close')">关闭</button>
      <button type="button" class="action strong" @click="openRecord">
        查看进度
      </button>
    </template>
    <template v-else>
      <button
        type="button"
        class="action"
        :disabled="!listed.length"
        @click="emit('select', allSelected ? [] : listed)"
      >
        {{ allSelected ? '取消全选' : '全选' }}
      </button>
      <p class="status">已选 {{ selected.length }} 项</p>
      <button type="button" class="action" @click="emit('close')">取消</button>
      <button
        type="button"
        class="action strong"
        :disabled="!selected.length"
        @click="sheet = true"
      >
        更新
      </button>
    </template>
  </div>
  <UpdateSheet
    :open="sheet"
    :target="{ target: 'many', ids: selected }"
    @started="onStarted"
    @cancel="sheet = false"
  />
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
</style>
