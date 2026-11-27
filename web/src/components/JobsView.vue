<script setup vapor lang="ts">
import { computed, shallowRef } from 'vue'
import { call, client, errorText, type QueueState } from '../api'
import { onShown } from '../composables/useShown'
import { toast } from '../composables/useToast'
import {
  jobTypeLabel,
  queueStatus,
  rateLimitEnd,
  rateLimitName,
  webLatency,
} from '../jobs'
import ListButton from './ui/ListButton.vue'
import ListSection from './ui/ListSection.vue'

// 设置 → 管理员面板 → 后台任务: what the worker is doing and how far behind
// it is; pausing all of it, or the job types that only tidy up; the APIs
// that rate-limited us, whose jobs wait for the end; how fast the web
// process has answered lately. Read again every few seconds while open.
const REFRESH = 5000
const state = shallowRef<QueueState>()
const now = shallowRef(new Date())
const error = shallowRef('')
const busy = shallowRef(false)
let timer: ReturnType<typeof setInterval> | undefined

async function load() {
  try {
    state.value = await call(client.queue.$get())
    now.value = new Date()
    error.value = ''
  } catch (e) {
    error.value = errorText(e)
  }
}
onShown(
  () => {
    void load()
    timer = setInterval(load, REFRESH)
  },
  () => clearInterval(timer),
)

async function save(json: { paused?: boolean; types?: string[] }) {
  if (busy.value) return
  busy.value = true
  try {
    state.value = await call(
      client.queue.control.$put({
        json: json as Parameters<typeof client.queue.control.$put>[0]['json'],
      }),
    )
  } catch (e) {
    toast(errorText(e))
  } finally {
    busy.value = false
  }
}
// Ends a limit early: its jobs run at once, and an API still limiting us
// says so again.
async function clearLimit(scope: string) {
  if (busy.value) return
  busy.value = true
  try {
    state.value = await call(
      client.queue['rate-limits'].clear.$post({ json: { scope } }),
    )
    now.value = new Date()
  } catch (e) {
    toast(errorText(e))
  } finally {
    busy.value = false
  }
}
function toggleType(type: string) {
  const types = state.value?.control.types ?? []
  void save({
    types: types.includes(type)
      ? types.filter((t) => t !== type)
      : [...types, type],
  })
}

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
      <ListButton
        :label="state.control.paused ? '继续' : '暂停全部'"
        :disabled="busy"
        @select="save({ paused: !state.control.paused })"
      />
    </ListSection>
    <ListSection title="按类型暂停">
      <ListButton
        v-for="type in state.pausable"
        :key="type"
        :label="jobTypeLabel(type)"
        :trailing="state.control.types.includes(type) ? '已暂停' : '运行'"
        :disabled="busy"
        @select="toggleType(type)"
      />
    </ListSection>
    <ListSection v-if="state.rate_limits.length" title="限流">
      <ListButton
        v-for="limit in state.rate_limits"
        :key="limit.scope"
        :label="rateLimitName(limit)"
        :hint="`${rateLimitEnd(limit, now)} · 等待 ${limit.waiting}`"
        trailing="解除"
        :disabled="busy"
        @select="clearLimit(limit.scope)"
      />
    </ListSection>
    <ListSection v-if="state.backlog.length" title="队列">
      <div v-for="row in state.backlog" :key="row.type" class="line">
        <span>{{ jobTypeLabel(row.type) }}</span>
        <span class="figures"
          >等待 {{ row.waiting
          }}<template v-if="row.running"> · 进行中 {{ row.running }}</template
          ><template v-if="row.paused"> · 暂停 {{ row.paused }}</template></span
        >
      </div>
    </ListSection>
    <ListSection v-if="latency" title="网页响应（最近 1 分钟）">
      <p class="line">{{ latency.requests }}</p>
      <p class="line">{{ latency.lag }}</p>
      <p v-if="latency.slow" class="line">{{ latency.slow }}</p>
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
