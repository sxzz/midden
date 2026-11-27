<script setup vapor lang="ts">
import { computed, shallowRef } from 'vue'
import { call, client, errorText } from '../api'
import { onShown } from '../composables/useShown'
import { useStale } from '../composables/useStale'
import { toast } from '../composables/useToast'
import {
  jobTypeLabel,
  queueStatus,
  rateLimitEnd,
  rateLimitName,
  slowQueryText,
  webLatency,
} from '../jobs'
import ListButton from './ui/ListButton.vue'
import ListSection from './ui/ListSection.vue'
import SkeletonRows from './ui/SkeletonRows.vue'

// 设置 → 管理员面板 → 后台任务: what the worker is doing and how far behind
// it is; pausing all of it, or the job types that only tidy up; the APIs
// that rate-limited us, whose jobs wait for the end; how fast the web
// process has answered lately, and the read queries that were slow. Read
// again every few seconds while open.
const REFRESH = 5000
const now = shallowRef(new Date())
const busy = shallowRef(false)
let timer: ReturnType<typeof setInterval> | undefined
// Each read every few seconds replaces the last in place; until the first
// answer a skeleton holds its place, and a failed read keeps the last one
// on screen with a line saying why.
const {
  data: state,
  error,
  pending,
  load: read,
} = useStale(() => call(client.queue.$get()))
// Slow queries, read alongside and kept the same way: the list stays as it
// was while the next read runs or if it fails.
const {
  data: slow,
  pending: slowPending,
  load: readSlow,
} = useStale(() => call(client.queue['slow-queries'].$get()))
async function load() {
  await Promise.all([read(), readSlow()])
  now.value = new Date()
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
const slowQueries = computed(() =>
  (slow.value?.items ?? []).map((q) => ({
    id: q.id,
    ...slowQueryText(q, now.value),
  })),
)
const latency = computed(() => state.value?.web && webLatency(state.value.web))
</script>

<template>
  <ListSection v-if="error" plain>
    <p class="banner" role="alert">{{ error }}</p>
  </ListSection>
  <template v-if="pending">
    <SkeletonRows :rows="2" label="正在读取后台任务" />
    <SkeletonRows title :rows="3" />
    <SkeletonRows title :rows="2" />
  </template>
  <template v-else-if="state">
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
        :hint="`${rateLimitEnd(limit, now)} · 等待${limit.waiting}`"
        trailing="解除"
        :disabled="busy"
        @select="clearLimit(limit.scope)"
      />
    </ListSection>
    <ListSection v-if="state.backlog.length" title="队列">
      <div v-for="row in state.backlog" :key="row.type" class="line">
        <span>{{ jobTypeLabel(row.type) }}</span>
        <span class="figures"
          >等待{{ row.waiting
          }}<template v-if="row.running"> · 进行中{{ row.running }}</template
          ><template v-if="row.paused"> · 暂停{{ row.paused }}</template></span
        >
      </div>
    </ListSection>
    <ListSection v-if="latency" title="网页响应（最近1分钟）">
      <p class="line">{{ latency.requests }}</p>
      <p class="line">{{ latency.lag }}</p>
      <p v-if="latency.slow" class="line">{{ latency.slow }}</p>
    </ListSection>
  </template>
  <SkeletonRows v-if="slowPending" title :rows="2" />
  <ListSection v-else-if="slow" title="慢查询（300 ms以上）">
    <p v-if="!slowQueries.length" class="line">无</p>
    <div v-for="q in slowQueries" :key="q.id" class="slow">
      <p class="slow-head">
        <span>{{ q.title }}</span>
        <span class="figures">{{ q.figures }}</span>
      </p>
      <p class="slow-query">{{ q.query }}</p>
    </div>
  </ListSection>
</template>

<style scoped>
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
.slow {
  margin: 0 0 0 var(--inset);
  padding: 10px var(--inset) 10px 0;
  box-shadow: inset 0 1px 0 var(--separator);
}
.slow:first-child {
  box-shadow: none;
}
.slow-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin: 0;
  font-size: 15px;
}
.slow-query {
  margin: 4px 0 0;
  overflow: hidden;
  color: var(--subtle);
  font-family: ui-monospace, monospace;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
