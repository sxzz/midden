<script setup vapor lang="ts">
import { computed, onActivated, onUnmounted, shallowRef, watch } from 'vue'
import { call, client, errorText, type CountsSeries } from '../api'
import { date } from '../presentation'
import { axisDate, tableRows, trends } from '../trends'
import TrendChart from './TrendChart.vue'
import ChevronIcon from './ui/ChevronIcon.vue'
import Spinner from './ui/Spinner.vue'
const props = defineProps<{ id: string }>()
const series = shallowRef<CountsSeries>()
const error = shallowRef('')
const loading = shallowRef(false)
/** The capture inspected on one chart, shown on every chart that read it. */
const selected = shallowRef<string>()
/** The table repeats what the charts show, so it stays folded until asked. */
const tableOpen = shallowRef(false)
let controller = new AbortController()
async function load() {
  controller.abort()
  controller = new AbortController()
  const { signal } = controller
  loading.value = true
  try {
    const result = await call(
      client.collections[':id'].counts.$get(
        { param: { id: props.id }, query: {} },
        { init: { signal } },
      ),
    )
    if (signal.aborted) return
    series.value = result
    error.value = ''
  } catch (e) {
    if (!signal.aborted) error.value = errorText(e)
  } finally {
    if (!signal.aborted) loading.value = false
  }
}
watch(
  () => props.id,
  () => {
    series.value = undefined
    selected.value = undefined
    void load()
  },
  { immediate: true },
)
// Kept in the navigation cache: coming back after a refresh shows its reading.
let mounted = false
onActivated(() => {
  if (mounted) void load()
  mounted = true
})
onUnmounted(() => controller.abort())
const list = computed(() => trends(series.value))
const rows = computed(() => tableRows(list.value))
const summary = computed(() => {
  const points = series.value?.points ?? []
  const first = Date.parse(points[0]?.observed_at ?? '')
  const last = Date.parse(points.at(-1)?.observed_at ?? '')
  if (!list.value.length || !Number.isFinite(first) || !Number.isFinite(last))
    return ''
  const span = last - first
  const range = `${axisDate(first, span)} – ${axisDate(last, span)}`
  return series.value?.truncated
    ? `最近 ${points.length} 次抓取 · ${range}`
    : `${points.length} 次抓取 · ${range}`
})
// A tap anywhere but a chart puts the charts back on their newest readings.
function release(event: PointerEvent) {
  if (!(event.target instanceof Element) || !event.target.closest('.plot'))
    selected.value = undefined
}
</script>

<template>
  <div class="trends" @pointerdown="release">
    <p v-if="error" class="banner" role="alert">{{ error }}</p>
    <p v-if="!series && loading" class="loading">
      <Spinner label="正在加载" />
    </p>
    <template v-if="list.length">
      <p class="summary">{{ summary }}</p>
      <div class="grid" :class="{ fetching: loading }">
        <TrendChart
          v-for="trend in list"
          :key="trend.key"
          :trend="trend"
          :selected-id="selected"
          @inspect="(id: string | undefined) => (selected = id)"
        />
      </div>
      <!-- Folds like the detail page's 我的整理 row rather than a native
           disclosure, so both pages open things the same way. -->
      <div class="table-view">
        <button
          type="button"
          class="toggle"
          :aria-expanded="tableOpen"
          :aria-controls="`trends-table-${id}`"
          @click="tableOpen = !tableOpen"
        >
          <span class="title">数据表</span>
          <span class="rows">{{ rows.length }} 行</span>
          <ChevronIcon :open="tableOpen" />
        </button>
        <div v-show="tableOpen" :id="`trends-table-${id}`" class="sheet">
          <div class="scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">抓取时间</th>
                  <th v-for="trend in list" :key="trend.key" scope="col">
                    {{ trend.label }}
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in rows" :key="row.id">
                  <th scope="row">
                    {{ date(new Date(row.at).toISOString()) }}
                  </th>
                  <td v-for="(value, i) in row.values" :key="i">{{ value }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.trends {
  padding: 0 var(--gutter);
}
.banner {
  margin: 0 0 16px;
  padding: 14px var(--inset);
  border-radius: var(--radius);
  background: var(--card);
  font-size: 15px;
  line-height: 1.5;
}
.loading {
  margin: 0;
  padding-top: 32px;
  text-align: center;
  color: var(--subtle);
}
.summary {
  margin: 0 0 8px;
  padding: 0 4px;
  font-size: 13px;
  color: var(--subtle);
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr));
  gap: 12px;
  transition: opacity 0.2s ease;
}
/* A refetch keeps the charts in place, dimmed, rather than flashing. */
.grid.fetching {
  opacity: 0.6;
}
.table-view {
  margin: 16px 0 0;
  background: var(--card);
  border-radius: var(--radius);
  overflow: hidden;
}
/* Same row as 我的整理 on the detail page: title left, quiet summary and
   chevron right. */
.toggle {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-height: 48px;
  padding: 11px var(--inset);
  color: var(--text);
  font-size: 16px;
  text-align: left;
}
.toggle:active {
  background: var(--fill);
}
.toggle .rows {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--subtle);
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Open, the table hangs under the toggle behind the inset hairline the app's
   grouped rows use. It sits outside the scroller so it stays put while the
   table scrolls sideways. */
.sheet {
  position: relative;
}
.sheet::before {
  content: '';
  position: absolute;
  inset: 0 0 auto var(--inset);
  height: 1px;
  background: var(--separator);
}
.scroll {
  overflow-x: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
th,
td {
  padding: 8px 12px;
  text-align: right;
  white-space: nowrap;
  border-bottom: 1px solid var(--separator);
}
thead th {
  font-weight: 500;
  color: var(--subtle);
}
th:first-child {
  padding-left: var(--inset);
  text-align: left;
}
tbody th {
  font-weight: 400;
  color: var(--subtle);
}
tbody tr:last-child > * {
  border-bottom: 0;
}
</style>
