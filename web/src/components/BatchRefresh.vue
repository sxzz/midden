<script setup vapor lang="ts">
import { computed, shallowRef } from 'vue'
import { toast } from '../composables/useToast'
import MediaRemovalSheet from './MediaRemovalSheet.vue'
import SelectionMenuSheet from './SelectionMenuSheet.vue'
import AppLink from './ui/AppLink.vue'
import UpdateSheet from './UpdateSheet.vue'
import type { RemovalEffect } from '../api'
const props = defineProps<{
  selected: string[]
  /** Every collection currently listed, for selecting them all at once. */
  listed: string[]
  /** The selected accounts' keys, which may be compared. */
  profiles?: string[]
}>()
const emit = defineEmits<{
  select: [ids: string[]]
  /** The update is running: selection ends, this bar stays to link to it. */
  started: []
  /** Asks to delete the selection; the list confirms it. */
  delete: []
  close: []
  /** Media of the selection was removed (删除媒体): sizes changed. */
  mediaRemoved: []
}>()
const sheet = shallowRef(false)
const removing = shallowRef(false)
const menu = shallowRef(false)
// The menu closes first: each choice is confirmed by its own sheet.
function openFromMenu(choice: 'media' | 'delete') {
  menu.value = false
  if (choice === 'media') removing.value = true
  else emit('delete')
}
function removed(effect: RemovalEffect) {
  removing.value = false
  toast(`已删除 ${effect.media} 个媒体`)
  emit('mediaRemoved')
}
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
</script>

<template>
  <div class="toolbar" role="region" aria-label="多选">
    <template v-if="started">
      <p class="status" role="status">已开始更新 {{ started.count }} 项</p>
      <button type="button" class="action" @click="emit('close')">关闭</button>
      <AppLink
        class="action strong"
        :to="{ name: 'capture', params: { id: started.record } }"
        @navigate="emit('close')"
      >
        查看进度
      </AppLink>
    </template>
    <template v-else>
      <button type="button" class="action" @click="emit('close')">取消</button>
      <p class="status selection">
        <span class="count">已选 {{ selected.length }} 项</span>
        <button
          type="button"
          class="select-all"
          :disabled="!listed.length"
          @click="emit('select', allSelected ? [] : listed)"
        >
          {{ allSelected ? '取消全选' : '全选' }}
        </button>
      </p>
      <button
        type="button"
        class="action strong"
        :disabled="!selected.length"
        @click="sheet = true"
      >
        更新
      </button>
      <button
        type="button"
        class="action more"
        aria-label="更多操作"
        title="更多操作"
        :disabled="!selected.length"
        @click="menu = true"
      >
        <svg
          viewBox="0 0 24 24"
          width="22"
          height="22"
          fill="currentColor"
          aria-hidden="true"
        >
          <circle cx="5.5" cy="12" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="18.5" cy="12" r="1.6" />
        </svg>
      </button>
    </template>
  </div>
  <UpdateSheet
    :open="sheet"
    :target="{ target: 'many', ids: selected }"
    @started="onStarted"
    @cancel="sheet = false"
  />
  <SelectionMenuSheet
    :open="menu"
    :count="selected.length"
    :profiles="profiles"
    @navigate="menu = false"
    @remove-media="openFromMenu('media')"
    @delete="openFromMenu('delete')"
    @cancel="menu = false"
  />
  <MediaRemovalSheet
    :open="removing"
    :target="{ ids: selected }"
    :title="`删除 ${selected.length} 项的媒体？`"
    @removed="removed"
    @cancel="removing = false"
  />
</template>

<style scoped>
.toolbar {
  position: sticky;
  bottom: max(8px, env(safe-area-inset-bottom));
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 2px;
  margin: 0 var(--gutter);
  padding: 4px;
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
.selection {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  padding: 0;
}
.count {
  white-space: nowrap;
  color: var(--text);
}
.select-all {
  min-height: 44px;
  padding: 0 4px;
  border-radius: 8px;
  font-size: 13px;
  color: var(--link);
  white-space: nowrap;
}
.action {
  display: grid;
  place-items: center;
  min-height: 44px;
  padding: 0 8px;
  border-radius: 8px;
  font-size: 15px;
  color: var(--link);
  white-space: nowrap;
}
.action.strong {
  font-weight: 600;
}
.action.more {
  display: grid;
  place-items: center;
  min-width: 40px;
  padding: 0;
}
.action:disabled,
.select-all:disabled {
  color: var(--subtle);
}
.action:active:not(:disabled),
.select-all:active:not(:disabled) {
  background: var(--fill);
}
</style>
