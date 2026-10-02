<script setup vapor lang="ts">
import { computed, shallowRef } from 'vue'
import { api, errorText, type UpdateMode } from '../api'
import { toast } from '../composables/useToast'
import UpdateModeSheet from './UpdateModeSheet.vue'
const props = defineProps<{
  selected: string[]
  /** Every collection currently listed, for selecting them all at once. */
  listed: string[]
}>()
const emit = defineEmits<{
  select: [ids: string[]]
  close: []
}>()
const choosing = shallowRef(false)
const busy = shallowRef(false)
const allSelected = computed(
  () =>
    props.listed.length > 0 &&
    props.listed.every((id) => props.selected.includes(id)),
)
// Progress is reported by the bot in the requester's private chat.
async function start(mode: UpdateMode) {
  busy.value = true
  try {
    await api('/refresh-batches', {
      method: 'POST',
      body: JSON.stringify({
        collection_ids: props.selected,
        update_mode: mode,
      }),
    })
    choosing.value = false
    emit('close')
  } catch (e) {
    toast(errorText(e))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="toolbar" role="region" aria-label="批量更新">
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
  </div>
  <UpdateModeSheet
    :open="choosing"
    :title="`更新 ${selected.length} 项收藏`"
    :busy="busy"
    @select="start"
    @cancel="choosing = false"
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
