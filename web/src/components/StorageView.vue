<script setup vapor lang="ts">
import { computed, shallowRef } from 'vue'
import {
  call,
  client,
  errorText,
  type StorageAlerts,
  type StorageReport,
} from '../api'
import { onShown } from '../composables/useShown'
import { ago, date, storageSize } from '../presentation'
import {
  gbMonths,
  HISTORY_RANGES,
  historyIn,
  share,
  storageTrends,
  tenThousands,
  times,
  usd,
  type HistoryRange,
} from '../storage'
import { formatCount } from '../trends'
import FolderNameSheet from './FolderNameSheet.vue'
import TrendChart from './TrendChart.vue'
import ListButton from './ui/ListButton.vue'
import ListSection from './ui/ListSection.vue'
import Spinner from './ui/Spinner.vue'

// 设置 → 管理员面板 → 存储用量: R2 from Cloudflare's analytics with the
// month's bill, this machine's disk, the database's make-up, the daily
// history and the alert thresholds. Without the analytics only the local
// parts show.
const report = shallowRef<StorageReport>()
const error = shallowRef('')
const loading = shallowRef(false)
async function load(refresh = false) {
  loading.value = true
  try {
    report.value = await call(
      client.storage.$get({ query: refresh ? { refresh: '1' } : {} }),
    )
    error.value = ''
  } catch (e) {
    error.value = errorText(e)
  } finally {
    loading.value = false
  }
}
onShown(() => load())

const r2 = computed(() => report.value?.r2 ?? undefined)
const cost = computed(() => report.value?.cost ?? undefined)
const local = computed(() => report.value?.local)
const composition = computed(() => report.value?.composition ?? undefined)

const costMonth = computed(() => {
  const c = cost.value
  if (!c) return ''
  const [year, month] = c.month.split('-').map(Number)
  return `${year}年${month}月，${c.days} 天的数据，按 R2 标准存储的价格。`
})

const range = shallowRef<HistoryRange>('30')
const trends = computed(() =>
  storageTrends(
    historyIn(report.value?.history ?? [], range.value),
    !!r2.value,
  ),
)
/** The day one chart inspects, shown on all of them. */
const selected = shallowRef<string>()
function release(event: PointerEvent) {
  if (!(event.target instanceof Element) || !event.target.closest('.plot'))
    selected.value = undefined
}

const ALERTS: Record<
  keyof StorageAlerts,
  {
    label: string
    format: (value: number) => string
    min: number
    max: number
    whole: boolean
    r2: boolean
  }
> = {
  cost_usd: {
    label: '本月 R2 费用超过',
    format: (v) => `$${v}`,
    min: 0.01,
    max: 10_000,
    whole: false,
    r2: true,
  },
  ops_percent: {
    label: 'R2 操作次数超过免费额度的',
    format: (v) => `${v}%`,
    min: 1,
    max: 100,
    whole: true,
    r2: true,
  },
  free_disk_gb: {
    label: '可用磁盘低于',
    format: (v) => `${v} GB`,
    min: 1,
    max: 100_000,
    whole: false,
    r2: false,
  },
  db_gb: {
    label: '数据库文件超过',
    format: (v) => `${v} GB`,
    min: 1,
    max: 100_000,
    whole: false,
    r2: false,
  },
}
const alertRows = computed(() =>
  (Object.keys(ALERTS) as (keyof StorageAlerts)[]).filter(
    (name) => !ALERTS[name].r2 || r2.value,
  ),
)
const editing = shallowRef<keyof StorageAlerts>()
const busy = shallowRef(false)
const editError = shallowRef('')
function edit(name: keyof StorageAlerts) {
  editError.value = ''
  editing.value = name
}
async function save(text: string) {
  const name = editing.value
  if (!name || busy.value || !report.value) return
  const { min, max, whole } = ALERTS[name]
  const value = Number(text)
  if (
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (whole && !Number.isInteger(value))
  ) {
    editError.value = `${whole ? '整数' : '数值'}，${min} 到 ${formatCount(max)}`
    return
  }
  busy.value = true
  try {
    const alerts = await call(
      client.storage.alerts.$put({ json: { [name]: value } }),
    )
    report.value = { ...report.value, alerts }
    editing.value = undefined
  } catch (e) {
    editError.value = errorText(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="storage" @pointerdown="release">
    <p v-if="error" class="banner" role="alert">{{ error }}</p>
    <p v-if="!report && loading" class="loading">
      <Spinner label="正在加载" />
    </p>
    <template v-if="report && local">
      <ListSection
        v-if="r2"
        title="R2"
        :footnote="`Cloudflare 分析数据，${ago(r2.fetched_at)}读取。`"
      >
        <template v-for="bucket in r2.buckets" :key="bucket.name">
          <p class="bucket">{{ bucket.name }}</p>
          <div v-if="bucket.bytes !== null" class="fact">
            <span class="name">存储</span>
            <span class="value">{{ storageSize(bucket.bytes) }}</span>
          </div>
          <div v-if="bucket.objects !== null" class="fact">
            <span class="name">对象</span>
            <span class="value">{{ formatCount(bucket.objects) }}</span>
          </div>
          <div class="fact">
            <span class="name">本月 Class A 操作</span>
            <span class="value">{{ times(bucket.class_a) }}</span>
          </div>
          <div class="fact">
            <span class="name">本月 Class B 操作</span>
            <span class="value">{{ times(bucket.class_b) }}</span>
          </div>
        </template>
        <ListButton label="刷新" :disabled="loading" @select="load(true)" />
      </ListSection>

      <ListSection v-if="cost" title="本月费用" :footnote="costMonth">
        <div class="fact">
          <span class="name"
            >存储<small class="hint"
              >{{ gbMonths(cost.storage.used) }}，免费额度
              {{ gbMonths(cost.storage.free) }}，已用
              {{ share(cost.storage.used, cost.storage.free) }}</small
            ></span
          >
          <span class="value">{{ usd(cost.storage.usd) }}</span>
        </div>
        <div class="fact">
          <span class="name"
            >Class A 操作<small class="hint"
              >{{ times(cost.class_a.used) }}，免费额度
              {{ tenThousands(cost.class_a.free) }}，已用
              {{ share(cost.class_a.used, cost.class_a.free) }}</small
            ></span
          >
          <span class="value">{{ usd(cost.class_a.usd) }}</span>
        </div>
        <div class="fact">
          <span class="name"
            >Class B 操作<small class="hint"
              >{{ times(cost.class_b.used) }}，免费额度
              {{ tenThousands(cost.class_b.free) }}，已用
              {{ share(cost.class_b.used, cost.class_b.free) }}</small
            ></span
          >
          <span class="value">{{ usd(cost.class_b.usd) }}</span>
        </div>
        <div class="fact total">
          <span class="name">合计</span>
          <span class="value">{{ usd(cost.usd) }}</span>
        </div>
      </ListSection>

      <ListSection title="本机">
        <div class="fact">
          <span class="name"
            >可用磁盘<small class="hint"
              >共 {{ storageSize(local.disk.total_bytes) }}</small
            ></span
          >
          <span class="value">{{ storageSize(local.disk.free_bytes) }}</span>
        </div>
        <div class="fact">
          <span class="name"
            >数据库文件<small class="hint"
              >空闲页 {{ formatCount(local.database.freelist_pages) }}（{{
                storageSize(
                  local.database.freelist_pages * local.database.page_size,
                )
              }}）· WAL {{ storageSize(local.database.wal_bytes) }}</small
            ></span
          >
          <span class="value">{{ storageSize(local.database.bytes) }}</span>
        </div>
        <div class="fact">
          <span class="name"
            >缩略图<small class="hint"
              >{{ formatCount(local.thumbnails.count) }} 个</small
            ></span
          >
          <span class="value">{{ storageSize(local.thumbnails.bytes) }}</span>
        </div>
        <div v-if="composition" class="fact">
          <span class="name"
            >媒体目录<small class="hint"
              >{{ formatCount(composition.media.files) }} 个文件，{{
                date(composition.computed_at)
              }}
              统计</small
            ></span
          >
          <span class="value">{{ storageSize(composition.media.bytes) }}</span>
        </div>
        <div class="fact">
          <span class="name"
            >部署前的数据库备份<small class="hint"
              >{{ local.deploy_backups.files }} 个文件</small
            ></span
          >
          <span class="value">{{
            storageSize(local.deploy_backups.bytes)
          }}</span>
        </div>
        <ListButton
          label="按占用空间排列收藏"
          chevron
          :to="{ name: 'collections', query: { sort: 'storage' } }"
        />
      </ListSection>

      <ListSection
        v-if="composition"
        title="数据库"
        :footnote="`${date(composition.computed_at)} 统计，用时 ${composition.seconds} 秒，每天一次。`"
      >
        <div v-for="item in composition.items" :key="item.name" class="fact">
          <span class="name"
            ><code>{{ item.name }}</code
            ><small class="hint">{{
              item.type === 'index' ? `索引 · ${item.table}` : '表'
            }}</small></span
          >
          <span class="value"
            >{{ storageSize(item.bytes) }}
            <small class="share">{{
              share(item.bytes, composition.total_bytes)
            }}</small></span
          >
        </div>
        <div v-if="composition.rest.count" class="fact">
          <span class="name">其余 {{ composition.rest.count }} 个</span>
          <span class="value">{{ storageSize(composition.rest.bytes) }}</span>
        </div>
        <div class="fact total">
          <span class="name">合计</span>
          <span class="value">{{ storageSize(composition.total_bytes) }}</span>
        </div>
      </ListSection>

      <ListSection v-if="trends.length" title="趋势" plain>
        <div class="segments" role="radiogroup" aria-label="时间范围">
          <label v-for="option in HISTORY_RANGES" :key="option.value"
            ><input
              v-model="range"
              type="radio"
              :value="option.value"
            /><span>{{ option.label }}</span></label
          >
        </div>
        <div class="grid">
          <TrendChart
            v-for="trend in trends"
            :key="trend.key"
            :trend="trend"
            :selected-id="selected"
            @inspect="(id: string | undefined) => (selected = id)"
          />
        </div>
      </ListSection>

      <ListSection
        title="提醒阈值"
        footnote="越过阈值和回落时，Bot 各发一条消息。"
      >
        <ListButton
          v-for="name in alertRows"
          :key="name"
          :label="ALERTS[name].label"
          :trailing="ALERTS[name].format(report.alerts[name])"
          chevron
          @select="edit(name)"
        />
      </ListSection>
    </template>
    <FolderNameSheet
      :open="!!editing"
      :title="editing ? ALERTS[editing].label : ''"
      confirm-label="保存"
      :name="editing && report ? String(report.alerts[editing]) : ''"
      placeholder=""
      label="阈值"
      :maxlength="8"
      :numeric="!!editing && ALERTS[editing].whole"
      :decimal="!!editing && !ALERTS[editing].whole"
      :busy="busy"
      :error="editError"
      @submit="save"
      @cancel="editing = undefined"
    />
  </div>
</template>

<style scoped>
.banner {
  margin: 0 var(--gutter) 16px;
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
.bucket {
  position: relative;
  margin: 0;
  padding: 14px var(--inset) 4px;
  font-size: 15px;
  font-weight: 600;
}
.fact {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 48px;
  padding: 11px var(--inset);
  font-size: 16px;
}
.fact + .fact::before,
.fact + :deep(.row)::before,
.fact + .bucket::before {
  content: '';
  position: absolute;
  inset: 0 0 auto var(--inset);
  height: 1px;
  background: var(--separator);
}
.name {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.hint {
  display: block;
  font-size: 13px;
  color: var(--subtle);
}
.value {
  flex-shrink: 0;
  color: var(--subtle);
  font-size: 15px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.share {
  display: block;
  font-size: 13px;
}
.total .name,
.total .value {
  font-weight: 600;
  color: var(--text);
}
code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 14px;
}
.segments {
  display: flex;
  gap: 2px;
  margin: 0 0 12px;
  padding: 2px;
  border-radius: 9px;
  background: var(--fill);
}
.segments label {
  position: relative;
  flex: 1;
  cursor: pointer;
}
.segments input {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: 0;
  overflow: hidden;
  clip-path: inset(50%);
}
.segments span {
  display: block;
  padding: 6px 8px;
  border-radius: 7px;
  font-size: 13px;
  text-align: center;
  white-space: nowrap;
}
.segments input:checked + span {
  background: var(--card);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
  font-weight: 600;
}
.segments input:focus-visible + span {
  outline: 2px solid var(--link);
  outline-offset: 1px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr));
  gap: 12px;
}
</style>
