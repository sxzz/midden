<script setup vapor lang="ts">
import {
  computed,
  onActivated,
  onDeactivated,
  onUnmounted,
  shallowRef,
  watch,
} from 'vue'
import { useRouter } from 'vue-router'
import {
  api,
  APIError,
  errorText,
  type CaptureMember,
  type CaptureRecord,
  type CaptureRecordDetail,
  type Job,
  type Page,
} from '../api'
import {
  linkTitle,
  mediaLabel,
  mediaStates,
  reasonText,
  recordCounts,
  recordProgress,
  recordStatus,
  recordTime,
  stateStatus,
} from '../captures'
import { toast } from '../composables/useToast'
import ListButton from './ui/ListButton.vue'
import ListSection from './ui/ListSection.vue'
const props = defineProps<{ id: string }>()
const emit = defineEmits<{
  /** A capture finished, so saved content changed. */
  saved: []
}>()
const router = useRouter()
const record = shallowRef<CaptureRecordDetail>()
const error = shallowRef('')
const busy = shallowRef(false)
const members = shallowRef<CaptureMember[]>([])
const membersNext = shallowRef('')
const membersLoading = shallowRef(false)
/** Members are many; the ones needing attention are listed first. */
const filter = shallowRef<'problem' | ''>('problem')
const filters = [
  { value: 'problem', label: '有问题的帖子' },
  { value: '', label: '全部帖子' },
] as const

const status = computed(() => record.value && recordStatus(record.value))
const counts = computed(() => (record.value ? recordCounts(record.value) : ''))
/** Every reason something is missing, the record's own failure first. */
const reasons = computed(() => {
  const r = record.value
  if (!r) return []
  const found = new Map<string, number>()
  const add = (reason: string | undefined, count = 1) => {
    const text = reason && reasonText(reason)
    if (text) found.set(text, (found.get(text) || 0) + count)
  }
  add(r.error)
  // A collection's reasons already count its members' media and warnings.
  if (r.members) for (const item of r.reasons) add(item.reason, item.count)
  else {
    for (const warning of r.warnings) add(warning)
    for (const m of r.media_items) if (m.state === 'failed') add(m.error)
  }
  return [...found].map(([text, count]) => ({ text, count }))
})
const failedMedia = computed(
  () => record.value?.media_items.filter((m) => m.state !== 'ready') ?? [],
)
const showAllMedia = shallowRef(false)
const media = computed(() =>
  showAllMedia.value ? (record.value?.media_items ?? []) : failedMedia.value,
)

let visible = true
let timer: ReturnType<typeof setTimeout> | undefined
// Leaving, switching record or reloading retires the previous poll chain.
let run = 0
function retire() {
  ++run
  clearTimeout(timer)
}
async function load() {
  const current = ++run
  clearTimeout(timer)
  try {
    const before = record.value
    const result = await api<CaptureRecordDetail>(`/captures/${props.id}`)
    if (current !== run) return
    record.value = result
    error.value = ''
    const settled = !!before && !before.done && result.done
    const progressed =
      !!before?.members && before.members.pending !== result.members?.pending
    if (settled) emit('saved')
    // Members settle while the record runs; keep the list in step with them.
    if (result.members && (!before || settled || progressed)) void loadMembers()
    if (!result.done && visible) timer = setTimeout(load, 2500)
  } catch (e) {
    if (current !== run) return
    if (record.value) toast(errorText(e))
    else
      error.value =
        e instanceof APIError && e.status === 404
          ? '采集记录不存在。'
          : errorText(e)
  }
}
let membersRun = 0
async function loadMembers(more = false) {
  if (more && (membersLoading.value || !membersNext.value)) return
  const current = ++membersRun
  membersLoading.value = true
  try {
    const q = new URLSearchParams()
    if (filter.value) q.set('state', filter.value)
    if (more) q.set('cursor', membersNext.value)
    const page = await api<Page<CaptureMember>>(
      `/captures/${props.id}/members?${q}`,
    )
    if (current !== membersRun) return
    members.value = more ? [...members.value, ...page.items] : page.items
    membersNext.value = page.next_cursor || ''
  } catch (e) {
    if (current === membersRun) toast(errorText(e))
  } finally {
    if (current === membersRun) membersLoading.value = false
  }
}
function setFilter(value: 'problem' | '') {
  if (filter.value === value) return
  filter.value = value
  members.value = []
  membersNext.value = ''
  void loadMembers()
}
watch(
  () => props.id,
  () => {
    record.value = undefined
    members.value = []
    membersNext.value = ''
    error.value = ''
    showAllMedia.value = false
    filter.value = 'problem'
    void load()
  },
  { immediate: true },
)
onActivated(() => {
  if (visible) return
  visible = true
  void load()
})
onDeactivated(() => {
  visible = false
  retire()
})
onUnmounted(retire)

/** Open the record a new capture created, or the list when it is not there. */
async function follow(job: Job) {
  try {
    const page = await api<Page<CaptureRecord>>('/captures')
    const created = page.items.find((r) => r.job_id === job.id)
    if (created && created.id !== props.id)
      return router.replace({ name: 'capture', params: { id: created.id } })
  } catch {
    // The list shows it either way.
  }
  return router.replace({ name: 'captures' })
}
async function retry() {
  if (busy.value) return
  busy.value = true
  try {
    const job = await api<Job>(`/captures/${props.id}/retry`, {
      method: 'POST',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
    })
    toast('已重新提交。')
    await follow(job)
  } catch (e) {
    toast(errorText(e))
  } finally {
    busy.value = false
  }
}
async function retryMember(member: CaptureMember) {
  if (busy.value) return
  busy.value = true
  try {
    await api('/captures', {
      method: 'POST',
      body: JSON.stringify({ url: member.url }),
      headers: { 'Idempotency-Key': crypto.randomUUID() },
    })
    toast('已重新提交。')
  } catch (e) {
    toast(errorText(e))
  } finally {
    busy.value = false
  }
}
async function stop() {
  if (busy.value) return
  busy.value = true
  try {
    await api(`/captures/${props.id}/stop`, { method: 'POST' })
    toast('已中止。')
    await load()
  } catch (e) {
    toast(errorText(e))
  } finally {
    busy.value = false
  }
}
function openCollection(id: string) {
  void router.push({ name: 'collection', params: { id } })
}
</script>

<template>
  <ListSection v-if="error" plain>
    <p class="banner" role="alert">{{ error }}</p>
  </ListSection>
  <p v-else-if="!record" class="status" role="status">加载中…</p>
  <template v-else>
    <ListSection>
      <div class="summary">
        <p class="title">{{ linkTitle(record.url) }}</p>
        <p class="state" :class="status?.tone" role="status">
          {{ status?.label }}<template v-if="counts"> · {{ counts }}</template>
        </p>
        <progress
          v-if="!record.done"
          class="bar"
          :value="recordProgress(record)"
          max="1"
          aria-label="采集进度"
        />
        <dl class="facts">
          <div>
            <dt>提交时间</dt>
            <dd>{{ recordTime(record.created_at) }}</dd>
          </div>
          <div v-if="record.finished_at && record.done">
            <dt>完成时间</dt>
            <dd>{{ recordTime(record.finished_at) }}</dd>
          </div>
          <div v-if="record.members">
            <dt>帖子</dt>
            <dd>
              {{
                `已保存 ${record.members.complete}，不完整 ${record.members.partial}，失败 ${record.members.failed}，进行中 ${record.members.pending}`
              }}
            </dd>
          </div>
          <div v-if="record.media.total">
            <dt>媒体</dt>
            <dd>
              {{
                `已保存 ${record.media.ready}/${record.media.total}，失败 ${record.media.failed}`
              }}
            </dd>
          </div>
        </dl>
      </div>
      <ListButton
        v-if="record.saved && record.state !== 'failed'"
        label="查看收藏"
        chevron
        @select="openCollection(record.collection_id)"
      />
      <ListButton label="打开原链接" :href="record.url" />
      <ListButton
        v-if="record.members && !record.done"
        label="中止"
        variant="destructive"
        :disabled="busy"
        @select="stop"
      />
      <ListButton
        v-if="record.done"
        :label="record.state === 'failed' ? '重试' : '重新采集'"
        :disabled="busy"
        @select="retry"
      />
    </ListSection>
    <ListSection v-if="reasons.length" title="失败原因">
      <p v-for="reason in reasons" :key="reason.text" class="line">
        <span class="line-text">{{ reason.text }}</span>
        <span v-if="reason.count > 1" class="line-trailing"
          >{{ reason.count }} 项</span
        >
      </p>
    </ListSection>
    <!-- Saved media need no list: the summary already counts them. -->
    <ListSection
      v-if="failedMedia.length"
      :title="showAllMedia ? '媒体明细' : '未保存的媒体'"
    >
      <p v-for="m in media" :key="m.position" class="line">
        <span class="line-text"
          >{{ mediaLabel(m)
          }}<small v-if="m.error" class="hint">{{
            reasonText(m.error)
          }}</small></span
        >
        <span class="line-trailing" :class="mediaStates[m.state].tone">{{
          mediaStates[m.state].label
        }}</span>
      </p>
      <ListButton
        v-if="!showAllMedia && failedMedia.length < record.media_items.length"
        :label="`显示全部 ${record.media_items.length} 项`"
        @select="showAllMedia = true"
      />
    </ListSection>
    <template v-if="record.members">
      <div class="tabs" role="tablist" aria-label="帖子明细">
        <button
          v-for="option in filters"
          :key="option.value"
          type="button"
          role="tab"
          class="tab"
          :class="{ on: filter === option.value }"
          :aria-selected="filter === option.value"
          @click="setFilter(option.value)"
        >
          {{ option.label }}
        </button>
      </div>
      <ListSection>
        <div v-for="m in members" :key="m.job_id" class="member">
          <button
            type="button"
            class="member-main"
            :disabled="!m.saved || m.state === 'failed'"
            @click="openCollection(m.collection_id)"
          >
            <span class="line-text"
              >{{ linkTitle(m.url)
              }}<small
                v-for="reason in m.error ? [m.error] : m.reasons"
                :key="reason"
                class="hint"
                >{{ reasonText(reason) }}</small
              ></span
            >
            <span class="line-trailing" :class="stateStatus(m.state).tone">{{
              stateStatus(m.state).label
            }}</span>
          </button>
          <button
            v-if="m.state === 'failed'"
            type="button"
            class="member-retry"
            :aria-label="`重试 ${linkTitle(m.url)}`"
            :disabled="busy"
            @click="retryMember(m)"
          >
            重试
          </button>
        </div>
        <p v-if="!members.length" class="line muted">
          {{
            membersLoading ? '加载中…' : filter ? '没有问题。' : '暂无帖子。'
          }}
        </p>
        <ListButton
          v-if="membersNext"
          label="加载更多"
          :disabled="membersLoading"
          @select="loadMembers(true)"
        />
      </ListSection>
    </template>
  </template>
</template>

<style scoped>
.banner {
  margin: 0;
  padding: 14px calc(var(--gutter) + 4px);
  font-size: 15px;
  line-height: 1.5;
}
.status {
  margin: 0;
  padding: 48px 32px;
  text-align: center;
  font-size: 15px;
  color: var(--subtle);
}
.summary {
  padding: 14px var(--inset) 12px;
}
.title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  word-break: break-all;
}
.state {
  margin: 4px 0 0;
  font-size: 14px;
  color: var(--subtle);
}
.active {
  color: var(--link);
}
.failed {
  color: var(--destructive);
}
.bar {
  display: block;
  width: 100%;
  height: 4px;
  margin-top: 10px;
  border: 0;
  border-radius: 2px;
  background: var(--fill);
  appearance: none;
  overflow: hidden;
}
.bar::-webkit-progress-bar {
  background: var(--fill);
}
.bar::-webkit-progress-value {
  background: var(--link);
  transition: width 300ms ease;
}
.bar::-moz-progress-bar {
  background: var(--link);
}
.facts {
  margin: 12px 0 0;
  font-size: 14px;
  line-height: 1.5;
}
.facts > div {
  display: flex;
  gap: 12px;
}
.facts dt {
  flex-shrink: 0;
  width: 4.5em;
  color: var(--subtle);
}
.facts dd {
  margin: 0;
  min-width: 0;
}
.summary + :deep(.row)::before {
  content: '';
  position: absolute;
  inset: 0 0 auto var(--inset);
  height: 1px;
  background: var(--separator);
}
.line,
.member {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 0;
  min-height: 44px;
  font-size: 15px;
}
.line {
  padding: 10px var(--inset);
}
.line + .line::before,
.member + .member::before,
.line + :deep(.row)::before,
.member + :deep(.row)::before {
  content: '';
  position: absolute;
  inset: 0 0 auto var(--inset);
  height: 1px;
  background: var(--separator);
}
.line.muted {
  color: var(--subtle);
}
.line-text {
  flex: 1;
  min-width: 0;
  word-break: break-all;
}
.line-trailing {
  flex-shrink: 0;
  font-size: 13px;
  color: var(--subtle);
}
.line-trailing.active {
  color: var(--link);
}
.line-trailing.failed {
  color: var(--destructive);
}
.hint {
  display: block;
  font-size: 13px;
  color: var(--subtle);
  word-break: normal;
}
.member-main {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 12px;
  min-width: 0;
  min-height: 44px;
  padding: 10px 0 10px var(--inset);
}
.member-main:last-child {
  padding-right: var(--inset);
}
.member-main:disabled {
  opacity: 1;
}
.member-retry {
  flex-shrink: 0;
  min-height: 44px;
  padding: 0 var(--inset) 0 4px;
  font-size: 15px;
  color: var(--link);
}
.member-retry:disabled {
  color: var(--subtle);
}
.member-main:active:not(:disabled),
.member-retry:active:not(:disabled) {
  background: var(--fill);
}
.tabs {
  display: flex;
  gap: 2px;
  margin: 0 var(--gutter) 12px;
  padding: 2px;
  border-radius: 10px;
  background: var(--fill);
}
.tab {
  flex: 1;
  min-height: 32px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  text-align: center;
  color: var(--subtle);
}
.tab.on {
  background: var(--card);
  color: var(--text);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
}
.tab:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: 1px;
}
</style>
