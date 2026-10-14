<script setup vapor lang="ts">
import {
  computed,
  onActivated,
  onDeactivated,
  onUnmounted,
  shallowRef,
} from 'vue'
import { useRouter } from 'vue-router'
import {
  api,
  errorText,
  type CaptureRecord,
  type CaptureRecordDetail,
  type Page,
} from '../api'
import {
  extractLinks,
  groupRecords,
  linkTitle,
  reasonText,
  recordCounts,
  recordProgress,
  recordRowTime,
  recordStatus,
} from '../captures'
import InfiniteLoader from './ui/InfiniteLoader.vue'
import ListButton from './ui/ListButton.vue'
import ListSection from './ui/ListSection.vue'
const emit = defineEmits<{
  /** A capture finished, so saved content changed. */
  saved: []
}>()
const router = useRouter()
const items = shallowRef<CaptureRecord[]>([])
const next = shallowRef('')
const loading = shallowRef(true)
const loaded = shallowRef(false)
const error = shallowRef('')
const text = shallowRef('')
const submitting = shallowRef(false)
const notice = shallowRef<{ text: string; failed?: boolean }>()
const links = computed(() => extractLinks(text.value))
const groups = computed(() => groupRecords(items.value))

let visible = true
let timer: ReturnType<typeof setTimeout> | undefined
// Only the newest refresh may write: one still in flight when the page is left
// or reloaded must not put older rows back.
let run = 0
/** Records beyond the first page that are followed one by one. */
const followed = 5
function settle(before: CaptureRecord[], after: CaptureRecord[]) {
  const running = new Set(before.filter((r) => !r.done).map((r) => r.id))
  if (after.some((r) => r.done && running.has(r.id))) emit('saved')
}
function schedule() {
  clearTimeout(timer)
  if (visible && items.value.some((r) => !r.done))
    timer = setTimeout(refresh, 2500)
}
/** Reload the first page in place, keeping older pages already listed. */
async function refresh() {
  const current = ++run
  try {
    const page = await api<Page<CaptureRecord>>('/captures')
    const fresh = new Map(page.items.map((r) => [r.id, r]))
    const older = items.value.filter((r) => !fresh.has(r.id))
    const updates = await Promise.all(
      older
        .filter((r) => !r.done)
        .slice(0, followed)
        .map((r) => api<CaptureRecordDetail>(`/captures/${r.id}`)),
    )
    if (current !== run) return
    for (const r of updates) fresh.set(r.id, r)
    const merged = [...page.items, ...older.map((r) => fresh.get(r.id) ?? r)]
    settle(items.value, merged)
    // The first page alone knows its cursor; keep the one further pages set.
    if (!older.length) next.value = page.next_cursor || ''
    items.value = merged
    error.value = ''
    loaded.value = true
  } catch (e) {
    if (current !== run) return
    if (!loaded.value) error.value = errorText(e)
  } finally {
    if (current === run) {
      loading.value = false
      schedule()
    }
  }
}
async function more() {
  if (loading.value || !next.value) return
  const current = ++run
  loading.value = true
  try {
    const page = await api<Page<CaptureRecord>>(
      `/captures?cursor=${encodeURIComponent(next.value)}`,
    )
    if (current !== run) return
    const known = new Set(items.value.map((r) => r.id))
    items.value = [
      ...items.value,
      ...page.items.filter((r) => !known.has(r.id)),
    ]
    next.value = page.next_cursor || ''
    error.value = ''
  } catch (e) {
    if (current === run) error.value = errorText(e)
  } finally {
    if (current === run) {
      loading.value = false
      schedule()
    }
  }
}
// Records also come from the bot; reload whenever the page reappears.
onActivated(() => {
  visible = true
  void refresh()
})
onDeactivated(() => {
  visible = false
  ++run
  clearTimeout(timer)
})
onUnmounted(() => {
  ++run
  clearTimeout(timer)
})

async function submit() {
  const targets = links.value
  if (!targets.length || submitting.value) return
  submitting.value = true
  notice.value = undefined
  const failed: string[] = []
  let reason = ''
  for (const url of targets) {
    try {
      await api('/captures', {
        method: 'POST',
        body: JSON.stringify({ url }),
        headers: { 'Idempotency-Key': crypto.randomUUID() },
      })
    } catch (e) {
      failed.push(url)
      reason ||= errorText(e)
    }
  }
  // What could not be submitted stays in the box to correct or send again.
  text.value = failed.join('\n')
  const sent = targets.length - failed.length
  notice.value = failed.length
    ? {
        text: `${sent ? `已提交 ${sent} 条，` : ''}${failed.length} 条未提交：${reason}`,
        failed: true,
      }
    : { text: `已提交 ${sent} 条。` }
  submitting.value = false
  await refresh()
}
function open(id: string) {
  void router.push({ name: 'capture', params: { id } })
}
</script>

<template>
  <ListSection title="采集链接">
    <form class="form" @submit.prevent="submit">
      <label class="field">
        <span class="field-label">链接</span>
        <textarea
          v-model="text"
          rows="3"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          placeholder="粘贴链接，可多条"
          @keydown.enter.meta.prevent="submit"
          @keydown.enter.ctrl.prevent="submit"
        />
      </label>
      <p
        v-if="notice"
        class="notice"
        :class="{ failed: notice.failed }"
        :role="notice.failed ? 'alert' : 'status'"
      >
        {{ notice.text }}
      </p>
      <button
        type="submit"
        class="submit"
        :disabled="submitting || !links.length"
      >
        {{
          submitting
            ? '正在提交…'
            : links.length > 1
              ? `采集 ${links.length} 条`
              : '采集'
        }}
      </button>
    </form>
  </ListSection>
  <ListSection v-if="error && !items.length">
    <p class="banner" role="alert">{{ error }}</p>
    <ListButton label="重试" @select="refresh" />
  </ListSection>
  <ListSection v-for="group in groups" :key="group.label" :title="group.label">
    <button
      v-for="r in group.items"
      :key="r.id"
      type="button"
      class="record"
      @click="open(r.id)"
    >
      <span class="main">
        <span class="title">{{ linkTitle(r.url) }}</span>
        <span class="meta">
          {{ recordRowTime(r.created_at)
          }}<template v-if="recordCounts(r)"> · {{ recordCounts(r) }}</template>
        </span>
        <span v-if="r.error" class="meta reason">{{
          reasonText(r.error)
        }}</span>
        <progress
          v-if="!r.done"
          class="bar"
          :value="recordProgress(r)"
          max="1"
          :aria-label="`${linkTitle(r.url)} 进度`"
        />
      </span>
      <span class="state" :class="recordStatus(r).tone">{{
        recordStatus(r).label
      }}</span>
      <span class="chevron" aria-hidden="true">›</span>
    </button>
  </ListSection>
  <p v-if="!items.length && loaded && !error" class="status">暂无采集记录</p>
  <p v-else-if="loading && !error" class="status" role="status">加载中…</p>
  <InfiniteLoader
    v-if="next && items.length"
    :loading="loading"
    :error="error"
    @more="more"
  />
</template>

<style scoped>
.form {
  margin: 0;
}
.field {
  display: block;
  padding: 13px var(--inset) 12px;
}
.field-label {
  display: block;
  margin-bottom: 9px;
  color: var(--subtle);
  font-size: 13px;
  font-weight: 600;
}
textarea {
  display: block;
  width: 100%;
  min-height: 82px;
  padding: 11px 13px;
  border: 0;
  border-radius: 12px;
  background: var(--fill);
  line-height: 1.55;
  font-size: 14px;
  resize: vertical;
  word-break: break-all;
}
textarea::placeholder {
  color: var(--subtle);
}
.notice {
  margin: 0;
  padding: 0 var(--inset) 12px;
  font-size: 14px;
  line-height: 1.5;
  color: var(--subtle);
}
.notice.failed {
  color: var(--destructive);
}
.submit {
  display: block;
  width: 100%;
  min-height: 48px;
  padding: 11px var(--inset);
  font-size: 16px;
  text-align: center;
  color: var(--link);
  box-shadow: inset 0 1px 0 var(--separator);
}
.submit:disabled {
  color: var(--subtle);
}
.submit:active:not(:disabled),
.record:active {
  background: var(--fill);
}
.banner {
  margin: 0;
  padding: 14px var(--inset);
  font-size: 15px;
  line-height: 1.5;
}
.status {
  margin: 0;
  padding: 48px 32px;
  text-align: center;
  font-size: 15px;
  line-height: 1.6;
  color: var(--subtle);
}
.record {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 56px;
  padding: 10px var(--inset);
}
.record + .record::before {
  content: '';
  position: absolute;
  inset: 0 0 auto var(--inset);
  height: 1px;
  background: var(--separator);
}
.main {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.title {
  overflow: hidden;
  font-size: 15px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta {
  font-size: 13px;
  line-height: 1.4;
  color: var(--subtle);
}
.meta.reason {
  color: var(--destructive);
}
.bar {
  width: 100%;
  height: 4px;
  margin-top: 5px;
  border: 0;
  border-radius: 2px;
  background: var(--fill);
  accent-color: var(--link);
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
.state {
  flex-shrink: 0;
  font-size: 13px;
  color: var(--subtle);
}
.state.active {
  color: var(--link);
}
.state.warn {
  color: var(--text);
}
.state.failed {
  color: var(--destructive);
}
.chevron {
  flex-shrink: 0;
  font-size: 22px;
  line-height: 1;
  color: var(--subtle);
  opacity: 0.55;
}
</style>
