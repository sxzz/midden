<script setup vapor lang="ts">
import { computed, shallowRef } from 'vue'
import { call, client, errorText, type WebSession } from '../api'
import { onShown } from '../composables/useShown'
import { useStale } from '../composables/useStale'
import { toast } from '../composables/useToast'
import { deviceName, sessionDetails } from '../sessions'
import ConfirmSheet from './ConfirmSheet.vue'
import ListButton from './ui/ListButton.vue'
import ListSection from './ui/ListSection.vue'
import SkeletonRows from './ui/SkeletonRows.vue'

// 设置 → 通行密钥 → 已登录的设备: every browser and Mini App signed in,
// this one first, and signing the others out.
const {
  data: items,
  error,
  pending,
  load,
} = useStale(() => call(client.sessions.$get()))
onShown(load)
defineExpose({ load })

const busy = shallowRef(false)
const removing = shallowRef<WebSession>()
const removingOthers = shallowRef(false)
const others = computed(() => items.value?.filter((s) => !s.current) ?? [])

async function act(request: () => Promise<unknown>, done: string) {
  if (busy.value) return
  busy.value = true
  try {
    await request()
    toast(done)
    await load()
  } catch (e) {
    toast(errorText(e))
  } finally {
    removing.value = undefined
    removingOthers.value = false
    busy.value = false
  }
}
function remove() {
  const s = removing.value
  if (!s) return
  void act(
    () => call(client.sessions[':id'].$delete({ param: { id: s.id } })),
    `已退出 ${deviceName(s)}`,
  )
}
function removeOthers() {
  void act(
    () => call(client.sessions['revoke-others'].$post()),
    '已退出其他所有设备',
  )
}
</script>

<template>
  <SkeletonRows v-if="pending" :rows="3" hint label="正在读取已登录的设备" />
  <ListSection v-else footnote="最近使用的时间精确到天。">
    <p v-if="error" class="banner" role="alert">{{ error }}</p>
    <div v-for="s in items" :key="s.id" class="session">
      <span class="label"
        >{{ deviceName(s)
        }}<span v-if="s.current" class="current">当前设备</span
        ><small class="hint">{{ sessionDetails(s) }}</small></span
      >
      <button
        v-if="!s.current"
        type="button"
        class="action"
        :aria-label="`退出 ${deviceName(s)}`"
        :disabled="busy"
        @click="removing = s"
      >
        退出
      </button>
    </div>
    <ListButton
      v-if="others.length"
      label="退出其他所有设备"
      variant="destructive"
      :disabled="busy"
      @select="removingOthers = true"
    />
  </ListSection>
  <ConfirmSheet
    :open="!!removing"
    :title="`退出 ${removing ? deviceName(removing) : ''}？`"
    :description="removing ? sessionDetails(removing) : undefined"
    confirm-label="退出"
    :busy="busy"
    @confirm="remove"
    @cancel="removing = undefined"
  />
  <ConfirmSheet
    :open="removingOthers"
    :title="`退出其他${others.length}个设备？`"
    confirm-label="退出其他所有设备"
    :busy="busy"
    @confirm="removeOthers"
    @cancel="removingOthers = false"
  />
</template>

<style scoped>
.banner {
  margin: 0;
  padding: 14px var(--inset);
  font-size: 15px;
  line-height: 1.5;
}
.session {
  position: relative;
  display: flex;
  align-items: center;
  min-height: 56px;
  padding-left: var(--inset);
}
.session + .session::before,
.session + :deep(.row)::before {
  content: '';
  position: absolute;
  inset: 0 0 auto var(--inset);
  height: 1px;
  background: var(--separator);
}
.label {
  flex: 1;
  min-width: 0;
  padding: 10px 0;
  font-size: 16px;
  overflow-wrap: anywhere;
}
.label:last-child {
  padding-right: var(--inset);
}
.current {
  margin-left: 8px;
  padding: 1px 6px;
  border-radius: 6px;
  background: var(--fill);
  font-size: 12px;
  color: var(--subtle);
  vertical-align: 2px;
}
.hint {
  display: block;
  font-size: 13px;
  line-height: 1.45;
  color: var(--subtle);
}
.action {
  flex-shrink: 0;
  min-height: 48px;
  padding: 0 var(--inset) 0 10px;
  font-size: 15px;
  color: var(--destructive);
}
.action:active:not(:disabled) {
  background: var(--fill);
}
</style>
