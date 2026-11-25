<script setup vapor lang="ts">
import { computed, onActivated, onDeactivated, shallowRef } from 'vue'
import { call, client, errorText, type QueueState } from '../api'
import { jobTypeLabel, queueStatus, webLatency } from '../jobs'
import ListSection from './ui/ListSection.vue'

// 设置 → 管理员面板 → 后台任务: what the worker is doing and how far behind
// it is; how fast the web process has answered lately. Read again every few
// seconds while open.
const REFRESH = 5000
const state = shallowRef<QueueState>()
const error = shallowRef('')
let timer: ReturnType<typeof setInterval> | undefined

async function load() {
  try {
    state.value = await call(client.queue.$get())
    error.value = ''
  } catch (e) {
    error.value = errorText(e)
  }
}
onActivated(() => {
  void load()
  timer = setInterval(load, REFRESH)
})
onDeactivated(() => clearInterval(timer))

const status = computed(() => state.value && queueStatus(state.value))
const latency = computed(() => state.value?.web && webLatency(state.value.web))
</script>

<template>
  <ListSection v-if="error" plain>
    <p class="banner" role="alert">{{ error }}</p>
  </ListSection>
  <p v-else-if="!state" class="status" role="status">加载中…</p>
  <template v-else>
    <ListSection>
      <p class="state" :class="status?.tone" role="status">
        {{ status?.label }}
      </p>
    </ListSection>
    <ListSection v-if="state.backlog.length" title="队列">
      <div v-for="row in state.backlog" :key="row.type" class="line">
        <span>{{ jobTypeLabel(row.type) }}</span>
        <span class="figures"
          >等待 {{ row.waiting
          }}<template v-if="row.running">
            · 进行中 {{ row.running }}</template
          ></span
        >
      </div>
    </ListSection>
    <ListSection v-if="latency" title="网页响应（最近 1 分钟）">
      <p class="line">{{ latency.requests }}</p>
      <p class="line">{{ latency.lag }}</p>
    </ListSection>
  </template>
</template>

<style scoped>
.status {
  margin: 24px var(--inset);
  color: var(--subtle);
}
.banner {
  margin: 0;
  color: var(--destructive);
}
.state {
  margin: 0;
  padding: 14px var(--inset);
  font-size: 16px;
}
.state.active {
  color: var(--link);
}
.state.failed {
  color: var(--destructive);
}
.line {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin: 0 0 0 var(--inset);
  padding: 12px var(--inset) 12px 0;
  font-size: 15px;
  box-shadow: inset 0 1px 0 var(--separator);
}
.line:first-child {
  box-shadow: none;
}
.figures {
  color: var(--subtle);
  font-variant-numeric: tabular-nums;
  text-align: right;
}
</style>
