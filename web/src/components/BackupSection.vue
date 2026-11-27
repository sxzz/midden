<script setup vapor lang="ts">
import { computed, shallowRef } from 'vue'
import { call, client, errorText, type LitestreamStatus } from '../api'
import { ago } from '../presentation'
import FolderNameSheet from './FolderNameSheet.vue'
import ListButton from './ui/ListButton.vue'
import ListSection from './ui/ListSection.vue'

// 设置 → 管理员面板 → 数据库备份: shown only where Litestream replicates the
// database. When its last heartbeat arrived, and how long without one counts
// as a failure.
const MIN = 1
const MAX = 1440
const props = defineProps<{
  status: LitestreamStatus
  /** Under a heading of its own (设置's entry), without its title. */
  bare?: boolean
}>()
const emit = defineEmits<{ saved: [status: LitestreamStatus] }>()
const editing = shallowRef(false)
const busy = shallowRef(false)
const error = shallowRef('')

const state = computed(() => {
  const { stale, last_heartbeat_at, stale_after_minutes } = props.status
  if (stale) return `超过${stale_after_minutes}分钟没有心跳`
  return last_heartbeat_at
    ? `上次心跳 ${ago(last_heartbeat_at)}`
    : '还没有收到心跳'
})

function open() {
  error.value = ''
  editing.value = true
}
async function save(text: string) {
  if (busy.value) return
  const minutes = Number(text)
  if (!Number.isInteger(minutes) || minutes < MIN || minutes > MAX) {
    error.value = `分钟数为${MIN}到${MAX}的整数`
    return
  }
  busy.value = true
  try {
    const next = await call(
      client.instance.litestream.$put({
        json: { stale_after_minutes: minutes },
      }),
    )
    editing.value = false
    emit('saved', next)
  } catch (e) {
    error.value = errorText(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <ListSection
    :title="bare ? undefined : '数据库备份'"
    footnote="Litestream每5分钟发一次心跳。"
  >
    <p class="state" :class="{ stale: status.stale }">{{ state }}</p>
    <ListButton
      label="备份心跳超时"
      :trailing="`${status.stale_after_minutes}分钟`"
      chevron
      @select="open"
    />
  </ListSection>
  <FolderNameSheet
    :open="editing"
    title="备份心跳超时（分钟）"
    confirm-label="保存"
    :name="String(status.stale_after_minutes)"
    placeholder=""
    label="分钟"
    :maxlength="4"
    numeric
    :busy="busy"
    :error="error"
    @submit="save"
    @cancel="editing = false"
  />
</template>

<style scoped>
.state {
  position: relative;
  margin: 0;
  padding: 14px var(--inset);
  font-size: 16px;
}
.state.stale {
  color: var(--destructive);
}
.state + :deep(.row)::before {
  content: '';
  position: absolute;
  inset: 0 0 auto var(--inset);
  height: 1px;
  background: var(--separator);
}
</style>
