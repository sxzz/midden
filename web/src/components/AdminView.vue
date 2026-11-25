<script setup vapor lang="ts">
import { computed, onActivated, shallowRef } from 'vue'
import {
  call,
  client,
  errorText,
  type LibrarySize,
  type LitestreamStatus,
} from '../api'
import { toast } from '../composables/useToast'
import BackupSection from './BackupSection.vue'
import ConfirmSheet from './ConfirmSheet.vue'
import OriginList from './OriginList.vue'
import ListButton from './ui/ListButton.vue'
import ListSection from './ui/ListSection.vue'

// 设置 → 管理员面板: what concerns the whole server rather than one person's
// settings. The domains the app may be used from; what storage is used;
// where Litestream replicates the database, its heartbeat; on a development
// server, deleting everything.
const emit = defineEmits<{
  /** Everything saved was deleted; lists must not show it any more. */
  cleared: []
}>()
const dev = shallowRef(false)
const litestream = shallowRef<LitestreamStatus>()
async function loadInstance() {
  try {
    const instance = await call(client.instance.$get())
    dev.value = instance.dev
    litestream.value = instance.litestream.enabled
      ? instance.litestream
      : undefined
  } catch {
    dev.value = false
    litestream.value = undefined
  }
}
onActivated(loadInstance)

const busy = shallowRef(false)
/** What deleting everything would remove, read when the sheet opens. */
const library = shallowRef<LibrarySize>()
const clearing = shallowRef(false)
const clearDescription = computed(() => {
  const v = library.value
  if (!v) return ''
  return `${v.collections} 条收藏、${v.records} 条采集记录${v.running ? `（${v.running} 条进行中）` : ''}，无法恢复。`
})
async function askClear() {
  if (busy.value) return
  busy.value = true
  try {
    library.value = await call(client.library.$get())
    clearing.value = true
  } catch (e) {
    toast(errorText(e))
  } finally {
    busy.value = false
  }
}
async function clearAll() {
  if (busy.value) return
  busy.value = true
  try {
    const v = await call(
      client.library['delete-all'].$post({ json: { confirm: 'delete all' } }),
    )
    clearing.value = false
    toast(`已删除 ${v.collections} 条收藏和 ${v.records} 条采集记录。`)
    emit('cleared')
  } catch (e) {
    toast(errorText(e))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <OriginList />
  <ListSection>
    <ListButton
      label="存储用量"
      variant="plain"
      chevron
      :to="{ name: 'settings-storage' }"
    />
  </ListSection>
  <BackupSection
    v-if="litestream"
    :status="litestream"
    @saved="litestream = $event"
  />
  <ListSection v-if="dev" title="开发模式">
    <ListButton
      label="删除全部收藏和采集记录"
      variant="destructive"
      :disabled="busy"
      @select="askClear"
    />
  </ListSection>
  <ConfirmSheet
    v-if="dev"
    :open="clearing"
    title="删除全部收藏和采集记录？"
    :description="clearDescription"
    confirm-label="永久删除"
    phrase="删除全部"
    :busy="busy"
    @confirm="clearAll"
    @cancel="clearing = false"
  />
</template>
