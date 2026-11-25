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
  APIError,
  call,
  client,
  errorText,
  type CaptureMember,
  type CaptureRecordDetail,
} from '../api'
import { optionsSummary } from '../capture-options'
import {
  canContinue,
  linkTitle,
  mediaLabel,
  mediaStates,
  profileHandle,
  profilePartText,
  recordAdditions,
  recordCounts,
  recordProgress,
  recordStatus,
  recordTime,
  recordTitle,
  retryParts,
  stateStatus,
} from '../captures'
import { toast } from '../composables/useToast'
import { relationsText } from '../follows'
import AppLink from './ui/AppLink.vue'
import InfiniteLoader from './ui/InfiniteLoader.vue'
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
const membersError = shallowRef('')
type MemberFilter = 'added' | 'updated' | 'problem' | 'pending' | ''
/** A tab: members by state, or `profiles`, each profile part by part. */
type Filter = MemberFilter | 'profiles'
interface FilterOption {
  value: Filter
  label: string
  count: number
}
/** Unset until the record loads, and while no tab has anything. */
const filter = shallowRef<Filter>()
/**
 * Only tabs with something in them are shown, so an empty one says nothing
 * at all. 账号 lists the profiles part by part, before the updated posts.
 * Running members are only under 进行中, shown while there are any; once
 * finished they move to the tab of their outcome. New and updated count
 * finished members only, like the record's counts. A record with members
 * from before new and updated were told apart lists them all instead.
 */
const filters = computed((): FilterOption[] => {
  const r = record.value
  if (!r) return []
  const m = r.members
  const profiles: FilterOption = {
    value: 'profiles',
    label: '账号',
    count: (r.profiles?.length ?? 0) + (r.more_profiles ?? 0),
  }
  if (!m) return profiles.count ? [profiles] : []
  const options: FilterOption[] =
    m.added !== undefined && m.updated !== undefined
      ? [
          {
            value: 'added',
            label: '新增记录',
            count: m.added,
          },
          profiles,
          {
            value: 'updated',
            label: '更新记录',
            count: m.updated,
          },
        ]
      : [
          {
            value: '',
            label: '全部',
            count: m.complete + m.partial + m.failed + m.pending,
          },
          profiles,
        ]
  options.push({
    value: 'problem',
    label: '异常记录',
    count: m.failed + m.partial,
  })
  // Last, so the other tabs stay put when it goes away.
  options.push({ value: 'pending', label: '进行中', count: m.pending })
  return options.filter((option) => option.count)
})
/**
 * A lone tab has nothing to switch to, so it becomes the list's heading;
 * 全部 alone just means the posts.
 */
const heading = computed(() => {
  const [only, other] = filters.value
  if (!only || other) return undefined
  return only.value ? only.label : '帖子'
})
/** Pages loaded per tab, so going back to a tab shows it at once. */
const cache = new Map<MemberFilter, { items: CaptureMember[]; next: string }>()

const status = computed(() => record.value && recordStatus(record.value))
const counts = computed(() => (record.value ? recordCounts(record.value) : ''))
const additions = computed(() =>
  record.value ? recordAdditions(record.value) : '',
)
/** Every reason something is missing, the record's own failure first. */
const reasons = computed(() => {
  const r = record.value
  if (!r) return []
  const found = new Map<string, number>()
  const add = (reason: string | undefined, count = 1) => {
    const text = reason?.trim()
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
    const result = await call(
      client.captures[':id'].$get({ param: { id: props.id } }),
    )
    if (current !== run) return
    record.value = result
    error.value = ''
    const settled = !!before && !before.done && result.done
    const progressed =
      !!before?.members && before.members.pending !== result.members?.pending
    if (settled) emit('saved')
    const options = filters.value
    // Open on the first tab; keep the one chosen while it still has posts.
    const kept = options.some((option) => option.value === filter.value)
    if (!kept) {
      filter.value = options[0]?.value
      members.value = []
      membersNext.value = ''
      // With no member tab open, retire a page still loading for the last one.
      if (filter.value === undefined || filter.value === 'profiles') {
        ++membersRun
        membersLoading.value = false
        membersError.value = ''
      }
    }
    // Members settle while the record runs; keep the list in step with them.
    if (result.members && (!before || !kept || settled || progressed)) {
      cache.clear()
      void loadMembers()
    }
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
  const state = filter.value
  if (state === undefined || state === 'profiles') return
  const current = ++membersRun
  membersLoading.value = true
  membersError.value = ''
  try {
    const page = await call(
      client.captures[':id'].members.$get({
        param: { id: props.id },
        query: {
          ...(state ? { state } : {}),
          ...(more ? { cursor: membersNext.value } : {}),
        },
      }),
    )
    if (current !== membersRun) return
    members.value = more ? [...members.value, ...page.items] : page.items
    membersNext.value = page.next_cursor || ''
    cache.set(state, { items: members.value, next: membersNext.value })
  } catch (e) {
    if (current === membersRun) membersError.value = errorText(e)
  } finally {
    if (current === membersRun) membersLoading.value = false
  }
}
function setFilter(value: Filter) {
  if (filter.value === value) return
  filter.value = value
  // 账号 comes with the record: nothing to load.
  const cached =
    value === 'profiles' ? { items: [], next: '' } : cache.get(value)
  if (cached) {
    // Retires a page still loading for the tab left behind.
    ++membersRun
    membersLoading.value = false
    membersError.value = ''
    members.value = cached.items
    membersNext.value = cached.next
    return
  }
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
    filter.value = undefined
    cache.clear()
    membersError.value = ''
    ++membersRun
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
async function follow(job: { id: string }) {
  try {
    const page = await call(client.captures.$get({ query: {} }))
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
    const { record_id: id } = await call(
      client.captures[':id'].retry.$post(
        { param: { id: props.id } },
        { headers: { 'Idempotency-Key': crypto.randomUUID() } },
      ),
    )
    toast(record.value?.update ? '已开始更新' : '已重新提交。')
    await router.replace({ name: 'capture', params: { id } })
  } catch (e) {
    toast(errorText(e))
  } finally {
    busy.value = false
  }
}
/**
 * Continue the listing like the bot's buttons. The pages fetched form a new
 * record, which is opened.
 */
async function page(op: 'more' | 'more1000' | 'page_retry') {
  if (busy.value) return
  busy.value = true
  try {
    const job = await call(
      client.captures[':id'].pages.$post(
        { param: { id: props.id }, json: { op } },
        { headers: { 'Idempotency-Key': crypto.randomUUID() } },
      ),
    )
    await follow(job)
  } catch (e) {
    toast(errorText(e))
  } finally {
    busy.value = false
  }
}
/**
 * Fetch again inside this record what failed or is incomplete: all of it,
 * or the part `id` names (a member, a page, a list, a profile's posts).
 */
async function retryFailed(id?: string) {
  if (busy.value) return
  busy.value = true
  try {
    const { count } = await call(
      client.captures[':id']['retry-failed'].$post({
        param: { id: props.id },
        json: id ? { id } : {},
      }),
    )
    toast(count ? `正在重试 ${count} 项。` : '没有可重试的项目。')
    cache.clear()
    await Promise.all([load(), loadMembers()])
  } catch (e) {
    toast(errorText(e))
  } finally {
    busy.value = false
  }
}
/** The options the record ran with, as far as they apply to its target. */
const optionsText = computed(() => {
  const r = record.value
  if (!r?.options) return ''
  return optionsSummary(
    r.options,
    r.update
      ? { profiles: r.update.profiles > 0, posts: r.update.posts > 0 }
      : { profiles: r.kind === 'profile', posts: r.kind !== 'profile' },
  )
})
/**
 * Read on where the post cap stopped a profile, inside this record: one of
 * an update's profiles, or the record's own.
 */
async function continueTimeline(collectionId?: string) {
  if (busy.value) return
  busy.value = true
  try {
    if (collectionId)
      await call(
        client.updates[':id'].continue.$post({
          param: { id: props.id },
          json: { collection_id: collectionId },
        }),
      )
    else
      await call(
        client.captures[':id'].pages.$post({
          param: { id: props.id },
          json: { op: 'continue' },
        }),
      )
    await load()
  } catch (e) {
    toast(errorText(e))
  } finally {
    busy.value = false
  }
}
/** Pause an update, or resume it from where it stopped. */
async function pause(paused: boolean) {
  if (busy.value) return
  busy.value = true
  try {
    const route = client.updates[':id'][paused ? 'pause' : 'resume']
    await call(route.$post({ param: { id: props.id } }))
    await load()
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
    await call(client.captures[':id'].stop.$post({ param: { id: props.id } }))
    toast('已中止。')
    await load()
  } catch (e) {
    toast(errorText(e))
  } finally {
    busy.value = false
  }
}
/** A member's line: its link, or the profile list it stands for. */
function memberTitle(m: CaptureMember) {
  if (!m.list) return linkTitle(m.url)
  return `${profileHandle(m.url, m.handle)} ${m.list === 'following' ? '关注' : '粉丝'}名单`
}
const retryLabel = computed(() => {
  if (record.value?.update) return '再次更新'
  return record.value?.state === 'failed' ? '重试' : '重新采集'
})
/** A collection's page, which a saved member or profile links to. */
const collectionPage = (id: string) => ({
  name: 'collection',
  params: { id },
})
/** Whether a member has a page to link to: saved, and not a profile list. */
const linked = (m: CaptureMember) => m.saved && m.state !== 'failed' && !m.list
</script>

<template>
  <ListSection v-if="error" plain>
    <p class="banner" role="alert">{{ error }}</p>
  </ListSection>
  <p v-else-if="!record" class="status" role="status">加载中…</p>
  <template v-else>
    <ListSection>
      <div class="summary">
        <p class="title">{{ recordTitle(record) }}</p>
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
          <div v-if="optionsText">
            <dt>选项</dt>
            <dd>{{ optionsText }}</dd>
          </div>
          <div v-if="record.members && !record.update">
            <dt>帖子</dt>
            <dd>
              {{
                `已保存 ${record.members.complete}，不完整 ${record.members.partial}，失败 ${record.members.failed}，进行中 ${record.members.pending}`
              }}
            </dd>
          </div>
          <div v-if="record.relations">
            <dt>关系网</dt>
            <dd>{{ relationsText(record.relations) }}</dd>
          </div>
          <div v-if="record.update?.skipped">
            <dt>跳过</dt>
            <dd>{{ record.update.skipped }} 项已删除或无法更新</dd>
          </div>
          <div v-if="additions">
            <dt>收藏</dt>
            <dd>{{ additions }}</dd>
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
        :to="collectionPage(record.collection_id)"
      />
      <ListButton v-if="record.url" label="打开原链接" :href="record.url" />
      <ListButton
        v-if="record.update && !record.done"
        :label="record.paused ? '继续' : '暂停'"
        :disabled="busy"
        @select="pause(!record.paused)"
      />
      <ListButton
        v-if="record.members && !record.done"
        label="中止"
        variant="destructive"
        :disabled="busy"
        @select="stop"
      />
      <ListButton
        v-if="record.pages?.capped"
        label="继续抓取"
        :disabled="busy"
        @select="continueTimeline()"
      />
      <ListButton
        v-if="record.pages?.more"
        label="抓取更多"
        :disabled="busy"
        @select="page('more')"
      />
      <ListButton
        v-if="record.pages?.more_1000"
        label="抓取 1000 条"
        :disabled="busy"
        @select="page('more1000')"
      />
      <ListButton
        v-if="record.pages?.failed"
        label="重试本页"
        :disabled="busy"
        @select="page('page_retry')"
      />
      <ListButton
        v-if="record.retryable"
        label="全部重试"
        :disabled="busy"
        @select="retryFailed()"
      />
      <ListButton
        v-if="record.done"
        :label="retryLabel"
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
          }}<small v-if="m.error" class="hint">{{ m.error }}</small></span
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
      <ListButton
        v-if="record.media_retryable && !record.profiles?.length"
        label="重试下载"
        :disabled="busy"
        @select="retryFailed(record.job_id)"
      />
    </ListSection>
    <template v-if="filters.length">
      <div v-if="!heading" class="tabs" role="tablist" aria-label="记录明细">
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
          {{ option.label }} <span class="tab-count">{{ option.count }}</span>
        </button>
      </div>
      <!-- The profiles, each with how its parts went. -->
      <ListSection
        v-if="filter === 'profiles'"
        :title="heading"
        :footnote="
          record.more_profiles
            ? `另有 ${record.more_profiles} 个账号`
            : undefined
        "
      >
        <template v-for="p in record.profiles" :key="p.collection_id">
          <AppLink class="line profile" :to="collectionPage(p.collection_id)">
            <span class="line-text"
              >{{ profileHandle(p.url, p.handle)
              }}<small class="hint">{{ profilePartText(p) }}</small
              ><small v-if="p.error" class="hint">{{ p.error }}</small></span
            >
            <span class="chevron" aria-hidden="true">›</span>
          </AppLink>
          <div v-for="part in retryParts(p)" :key="part.id" class="member part">
            <span class="member-main"
              ><span class="line-text"
                >{{ part.label
                }}<small class="hint">{{ part.detail }}</small></span
              ></span
            >
            <button
              type="button"
              class="member-retry"
              :aria-label="`重试 ${profileHandle(p.url, p.handle)} ${part.label}`"
              :disabled="busy"
              @click="retryFailed(part.id)"
            >
              重试
            </button>
          </div>
          <ListButton
            v-if="canContinue(p)"
            label="继续抓取"
            :disabled="busy"
            @select="continueTimeline(p.collection_id)"
          />
        </template>
      </ListSection>
      <template v-else>
        <ListSection :title="heading">
          <div v-for="m in members" :key="m.job_id" class="member">
            <component
              :is="linked(m) ? AppLink : 'span'"
              class="member-main"
              :to="linked(m) ? collectionPage(m.collection_id) : undefined"
            >
              <span class="line-text"
                >{{ memberTitle(m)
                }}<small
                  v-for="reason in m.error ? [m.error] : m.reasons"
                  :key="reason"
                  class="hint"
                  >{{ reason }}</small
                ></span
              >
              <span
                class="line-trailing"
                :class="stateStatus(m.state, m.waiting).tone"
                >{{ stateStatus(m.state, m.waiting).label }}</span
              >
            </component>
            <button
              v-if="m.retryable"
              type="button"
              class="member-retry"
              :aria-label="`重试 ${memberTitle(m)}`"
              :disabled="busy"
              @click="retryFailed(m.job_id)"
            >
              重试
            </button>
          </div>
          <p v-if="!members.length && membersLoading" class="line muted">
            加载中…
          </p>
        </ListSection>
        <InfiniteLoader
          v-if="membersNext || membersError"
          :loading="membersLoading"
          :error="membersError"
          @more="loadMembers(!!membersNext)"
        />
      </template>
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
.profile {
  width: 100%;
  text-align: left;
}
a.profile,
a.member-main {
  color: inherit;
}
.profile:active {
  background: var(--fill);
}
.chevron {
  flex-shrink: 0;
  color: var(--subtle);
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
a.member-main:active,
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
  /* Four tabs may not fit a narrow phone on one line; the count wraps. */
  min-width: 0;
  padding: 4px;
  min-height: 32px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  text-align: center;
  color: var(--subtle);
  transition:
    background 160ms ease,
    color 160ms ease;
}
.tab.on {
  background: var(--card);
  color: var(--text);
  /* The ring keeps it apart in dark themes, where the card is darker than
     the track. */
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--text) 12%, transparent),
    0 1px 3px rgba(0, 0, 0, 0.12);
}
.tab-count {
  font-weight: 400;
  font-variant-numeric: tabular-nums;
  color: var(--subtle);
}
.tab:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: 1px;
}
</style>
