<script setup vapor lang="ts">
import {
  computed,
  onActivated,
  onMounted,
  onUnmounted,
  reactive,
  shallowRef,
  watch,
} from 'vue'
import {
  call,
  client,
  errorText,
  type Author,
  type Tag,
  type TagChange,
} from '../api'
import { kindOf, KINDS, localDay, type Kind } from '../folders'
import { listSort, listsProfiles } from '../presentation'
import TagEditSheet from './TagEditSheet.vue'
import ChevronIcon from './ui/ChevronIcon.vue'
import MultiSelect from './ui/MultiSelect.vue'
import TagChips from './ui/TagChips.vue'
const tags = shallowRef<Tag[]>([])
const tagError = shallowRef('')
async function loadTags() {
  try {
    tags.value = await call(client.tags.$get())
    tagError.value = ''
  } catch (e) {
    tagError.value = errorText(e)
  }
}
onMounted(loadTags)
onActivated(loadTags)
const props = defineProps<{
  query: string
  /** One account's own list: its platform and author are given. */
  withinProfile?: boolean
  /**
   * A folder's list: its filter may name posts, accounts or both, where a
   * home tab's list is one of them.
   */
  folder?: boolean
}>()
const emit = defineEmits<{
  search: [query: string]
  /** A tag was renamed, merged into another or deleted. */
  tagsChanged: [change: TagChange]
}>()
/** The one value all of these share, or nothing. */
function only<T extends string>(items: T[]): T | '' {
  return items.length && items.every((item) => item === items[0])
    ? items[0]!
    : ''
}
function read(query: string) {
  const params = new URLSearchParams(query)
  const types = (params.get('entity_type') || '').split(',').filter(Boolean)
  const platform = only(types.map((type) => type.split('.')[0] || ''))
  return {
    tag: params.get('tag') || '',
    postType: params.get('post_type') || '',
    authors: params.getAll('author'),
    layout: params.get('layout') === 'album' ? 'album' : '',
    order: params.get('order') || 'desc',
    sort: listSort(params),
    q: params.get('q') || '',
    // Which tab this form belongs to; it rides along, and only a folder's
    // form edits the kind.
    entity: params.get('entity_type') || '',
    kind: only(types.map(kindOf)),
    /** The kind a folder holding both shows; it rides along. */
    tab: params.get('tab') || '',
    platform: platform === 'x' || platform === 'instagram' ? platform : '',
    media: (params.get('media_type') || '').split(',').filter(Boolean),
    visibility: params.get('visibility') || '',
    sensitive: params.get('sensitive') || '',
    from: params.get('from_date') || '',
    to: params.get('to_date') || '',
    /** A relative range such as `7d`, counted again on every visit. */
    within: params.get('saved_within') || '',
    /** Where its days are counted, when not this browser's zone. */
    zone: params.get('time_zone') || '',
  }
}
type Form = ReturnType<typeof read>
const form = reactive(read(props.query))
/** The kind of list shown, which decides the controls and default order. */
const shownKind = (f: Form): Kind =>
  f.tab === 'post' || f.tab === 'profile'
    ? f.tab
    : f.kind === 'profile'
      ? 'profile'
      : 'post'
// Authors, media and sensitivity describe posts; an account has none of them.
const posts = computed(() => shownKind(form) === 'post')
/**
 * The entity types the form selects. A home tab's kind is fixed and its
 * posts are the default, left out of the address; in a folder, no kind and
 * no platform select everything.
 */
function entityTypes(f: Form) {
  if (props.folder && !f.kind && !f.platform) return ''
  if (!props.folder && f.kind !== 'profile' && !f.platform) return ''
  const kinds = f.kind ? [f.kind] : props.folder ? KINDS : ['post']
  const platforms = f.platform ? [f.platform] : ['x', 'instagram']
  return kinds
    .flatMap((kind) => platforms.map((name) => `${name}.${kind}`))
    .join(',')
}
const kindNames: Record<Kind, string> = { post: '帖子', profile: '账号' }
const postTypeNames: Record<string, string> = {
  post: '贴文',
  quote: '引用',
  repost: '转发',
}
const mediaNames: Record<string, string> = {
  image: '图片',
  video: '视频',
  text: '纯文字',
}
const visibilityNames: Record<string, string> = {
  public: '公开',
  private: '私密',
}
const sensitiveNames: Record<string, string> = {
  contains: '包含敏感内容',
  not_contains: '不含敏感内容',
}
/** Local calendar day `days` before today, as a date input writes it. */
function daysAgo(days: number) {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return localDay(d)
}
const WITHIN = /^(\d+)d$/
const withinDays = (within: string) => Number(WITHIN.exec(within)?.[1])
const withinLabel = (within: string) => {
  const days = withinDays(within)
  return days === 1 ? '今天' : days > 1 ? `最近 ${days} 天` : ''
}
// Relative: the server counts the days again on every visit, so a folder
// saved with one keeps showing the latest days.
const rangeOptions = computed(() =>
  ['1d', '7d', '30d', form.within]
    .filter((value, i, all) => value && all.indexOf(value) === i)
    .filter((value) => withinLabel(value))
    .map((value) => ({ value, label: withinLabel(value) })),
)
// A native date field fills in today as soon as its picker opens on a phone,
// which would filter the list by accident. The common ranges are one tap, and
// the two fields only appear once a custom range is asked for.
const customRange = shallowRef(false)
const range = computed({
  get() {
    if (customRange.value) return 'custom'
    if (form.within) return form.within
    return form.from || form.to ? 'custom' : ''
  },
  set(value) {
    customRange.value = value === 'custom'
    if (customRange.value) {
      // The fields start at the same days, which stay fixed from now on.
      if (form.within) form.from = daysAgo(withinDays(form.within) - 1)
      form.within = ''
      form.zone = ''
      return
    }
    form.within = value
    form.zone = ''
    form.from = ''
    form.to = ''
  },
})
const open = shallowRef(
  !!(
    form.postType ||
    form.platform ||
    form.tag ||
    form.authors.length ||
    form.media.length ||
    form.visibility ||
    form.sensitive ||
    form.from ||
    form.to ||
    form.within ||
    (props.folder && form.kind)
  ),
)
const active = computed(() =>
  [
    props.folder && form.kind ? kindNames[form.kind] : '',
    form.platform ? (form.platform === 'instagram' ? 'Instagram' : 'X') : '',
    form.tag
      ? tags.value.find((tag) => tag.id === form.tag)?.name || '已选标签'
      : '',
    form.media.map((type) => mediaNames[type]).join('、'),
    // Authors are selected by identity; only their names are worth showing.
    form.authors.map((id) => authorNames.value[id] || id).join('、'),
    postTypeNames[form.postType],
    visibilityNames[form.visibility],
    sensitiveNames[form.sensitive],
    withinLabel(form.within) ||
      (form.from && form.to
        ? `${form.from} 至 ${form.to}`
        : form.from
          ? `${form.from} 起`
          : form.to
            ? `${form.to} 前`
            : ''),
  ]
    .filter(Boolean)
    .join(' · '),
)
function stringify(f: Form) {
  const q = new URLSearchParams()
  for (const [k, v] of [
    ['tag', f.tag],
    ['post_type', f.postType],
    ['q', f.q],
    ['layout', f.layout],
    ['tab', f.tab],
    // The default order stays out of the address.
    ['sort', f.sort === listSort(`tab=${shownKind(f)}`) ? '' : f.sort],
    ['order', f.order === 'desc' ? '' : f.order],
    ['media_type', f.media.join(',')],
    ['visibility', f.visibility],
    ['sensitive', f.sensitive],
    ['from_date', f.from],
    ['to_date', f.to],
    ['saved_within', f.within],
    ['time_zone', f.within ? f.zone : ''],
    ['entity_type', entityTypes(f)],
  ])
    if (v) q.set(k, v)
  for (const author of f.authors) q.append('author', author)
  return q.toString()
}
const build = () => stringify(form)
/** The last query this component and its parent agree on, canonicalised so
    neither the auto-search watcher nor the `query` sync can echo one back —
    the router may re-encode or reorder what we emitted. */
let settled = build()
/** A range the user is still halfway through typing is not a filter yet. */
const usable = () => !form.from || !form.to || !(form.from > form.to)
function search() {
  if (!usable()) return
  const query = build()
  if (query === settled) return
  settled = query
  emit('search', query)
}
function clear() {
  const { layout, entity, tab } = form
  const q = new URLSearchParams()
  if (layout) q.set('layout', layout)
  if (tab) q.set('tab', tab)
  // A home tab keeps its kind; a folder's kind is one of its filters.
  if (!props.folder && listsProfiles(`entity_type=${entity}`))
    q.set('entity_type', 'x.profile,instagram.profile')
  Object.assign(form, read(q.toString()))
  customRange.value = false
  settled = build()
  emit('search', q.toString())
}
/** The tab, the layout and the account a list belongs to are not filters:
    they alone leave nothing to clear. */
const clearable = computed(() => {
  const q = new URLSearchParams(props.query)
  if (!props.folder) q.delete('entity_type')
  q.delete('layout')
  q.delete('tab')
  q.delete('related_to')
  return !!form.platform || [...q.values()].some(Boolean)
})
// Every discrete control applies itself; only the keyword box waits for Enter.
watch(
  () => [
    form.kind,
    form.platform,
    form.postType,
    form.tag,
    form.sort,
    form.order,
    form.visibility,
    form.sensitive,
    form.from,
    form.to,
    form.within,
    form.media.join(','),
    JSON.stringify(form.authors),
  ],
  () => search(),
)
// Back/forward (and any other outside change) rewrites the form. `settled`
// already holds whatever we emitted, so our own queries never round-trip.
watch(
  () => props.query,
  (query) => {
    const incoming = read(query)
    if (stringify(incoming) === settled) return
    settled = stringify(incoming)
    Object.assign(form, incoming)
    if (incoming.within || (!incoming.from && !incoming.to))
      customRange.value = false
  },
)
// Authors come a page at a time, most saved posts first, and the search runs
// on the server: a large library has thousands of them.
const authors = shallowRef<Author[]>([])
const authorQuery = shallowRef('')
const authorsNext = shallowRef('')
const authorError = shallowRef('')
const authorsLoading = shallowRef(false)
const authorsLoaded = shallowRef(false)
/** Names of every author seen, so a selection reads by name. */
const authorNames = shallowRef<Record<string, string>>({})
const wantsAuthors = () => posts.value && !props.withinProfile
const controller = new AbortController()
onUnmounted(() => controller.abort())
function remember(items: Author[]) {
  const fresh = items.filter((a) => authorNames.value[a.id] !== a.name)
  if (fresh.length)
    authorNames.value = {
      ...authorNames.value,
      ...Object.fromEntries(fresh.map((a) => [a.id, a.name || a.id])),
    }
}
let authorRequest = 0
async function loadAuthors(more = false) {
  const request = ++authorRequest
  authorsLoading.value = true
  authorError.value = ''
  try {
    const data = await call(
      client.collections.authors.$get(
        {
          query: {
            q: authorQuery.value.trim() || undefined,
            cursor: more ? authorsNext.value : undefined,
          },
        },
        { init: { signal: controller.signal } },
      ),
    )
    // A newer search superseded this one.
    if (request !== authorRequest) return
    remember(data.items)
    authors.value = more ? [...authors.value, ...data.items] : data.items
    authorsNext.value = data.next_cursor ?? ''
    authorsLoaded.value = true
  } catch (error) {
    if (request === authorRequest && !controller.signal.aborted)
      authorError.value = errorText(error)
  } finally {
    if (request === authorRequest) authorsLoading.value = false
  }
}
// Only once the author list is opened: most visits to the panel never do.
function openAuthors() {
  if (!authorsLoaded.value && !authorsLoading.value) void loadAuthors()
}
let searchTimer: ReturnType<typeof setTimeout> | undefined
onUnmounted(() => clearTimeout(searchTimer))
function searchAuthors(query: string) {
  authorQuery.value = query
  clearTimeout(searchTimer)
  searchTimer = setTimeout(loadAuthors, 250)
}
// A selection from the address (a reload, a shared link) needs its names
// even while the panel is closed: the summary shows them.
watch(
  () => form.authors,
  async (ids) => {
    const missing = ids.filter((id) => !(id in authorNames.value))
    if (!missing.length || !wantsAuthors()) return
    try {
      remember(
        (
          await call(
            client.collections.authors.$get(
              { query: { author: missing } },
              { init: { signal: controller.signal } },
            ),
          )
        ).items,
      )
    } catch {
      // The ids stand in for names.
    }
  },
  { immediate: true },
)
// Two accounts may share a display name, so the label is never the value.
// Selected authors beyond the loaded page stay listed so they can be undone.
const authorOptions = computed(() => {
  const options = authors.value.map((author) => ({
    value: author.id,
    label: author.name || author.id,
    detail: String(author.count),
  }))
  if (!authorQuery.value.trim())
    for (const id of form.authors)
      if (!authors.value.some((author) => author.id === id))
        options.push({
          value: id,
          label: authorNames.value[id] || id,
          detail: '',
        })
  return options
})
const mediaOptions = Object.entries(mediaNames).map(([value, label]) => ({
  value,
  label,
}))
// Tags are managed where they are picked: each chip opens its editor.
const managing = shallowRef(false)
const editing = shallowRef<Tag>()
async function tagChanged(change: TagChange) {
  editing.value = undefined
  emit('tagsChanged', change)
  await loadTags()
  if (!tags.value.length) managing.value = false
  // A filter on a tag merged away follows it; on a deleted one, it goes.
  if (form.tag === change.from) form.tag = change.to?.id ?? ''
}
// The API filters on one tag, so the chips are a single-choice group; the
// query string keeps storing it as a scalar.
const tagFilter = computed({
  get: () => (form.tag ? [form.tag] : []),
  set: (value) => {
    form.tag = value[0] ?? ''
  },
})
</script>

<template>
  <form class="filters" @submit.prevent="search">
    <div class="bar">
      <svg
        class="glass"
        viewBox="0 0 24 24"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <circle cx="10.5" cy="10.5" r="6" />
        <path d="M15 15l4.5 4.5" />
      </svg>
      <input
        v-model="form.q"
        type="search"
        class="field"
        placeholder="搜索收藏"
        aria-label="搜索正文或作者"
        maxlength="500"
      /><button type="submit" class="submit">搜索</button>
    </div>
    <!-- Filter summary and sort share one line; the sort pickers are named
         by their own values, so they need no visible label. -->
    <div class="toggles">
      <button
        type="button"
        class="toggle"
        :aria-expanded="open"
        @click="open = !open"
      >
        筛选
        <ChevronIcon :open="open" />
      </button>
      <button
        v-if="clearable"
        type="button"
        class="toggle reset"
        @click="clear"
      >
        清除
      </button>
      <span class="sort"
        ><span class="select"
          ><select v-model="form.sort" aria-label="排序">
            <option v-if="posts" value="published">发帖时间</option>
            <option value="saved">添加时间</option>
            <option value="updated">更新时间</option>
            <option value="storage">存储空间</option></select
          ><ChevronIcon class="select-chevron" /></span
        ><span class="select"
          ><select v-model="form.order" aria-label="排序方向">
            <option value="desc">
              {{ form.sort === 'storage' ? '从大到小' : '从新到旧' }}
            </option>
            <option value="asc">
              {{ form.sort === 'storage' ? '从小到大' : '从旧到新' }}
            </option></select
          ><ChevronIcon class="select-chevron" /></span
      ></span>
    </div>
    <!-- On its own line: beside the sort pickers a phone has room for a
         word or two of it. -->
    <p v-if="active" class="filter-summary">{{ active }}</p>
    <div v-show="open" class="panel">
      <label v-if="folder" class="option">
        类型<span class="select"
          ><select v-model="form.kind" aria-label="类型">
            <option value="">全部</option>
            <option value="post">帖子</option>
            <option value="profile">账号</option></select
          ><ChevronIcon class="select-chevron"
        /></span>
      </label>
      <label v-if="!withinProfile" class="option">
        平台<span class="select"
          ><select v-model="form.platform" aria-label="平台">
            <option value="">全部</option>
            <option value="x">X</option>
            <option value="instagram">Instagram</option></select
          ><ChevronIcon class="select-chevron"
        /></span>
      </label>
      <!-- Tags are your own vocabulary, so they get the same chips as in the
           collection itself, not a picker that hides them. -->
      <div v-if="tags.length || tagError" class="tag-filter">
        <p class="tag-title">
          标签<button
            v-if="tags.length"
            type="button"
            class="manage"
            :aria-pressed="managing"
            @click="managing = !managing"
          >
            {{ managing ? '完成' : '编辑' }}
          </button>
        </p>
        <div
          v-if="managing"
          class="tag-edit"
          role="group"
          aria-label="编辑标签"
        >
          <button
            v-for="tag in tags"
            :key="tag.id"
            type="button"
            class="tag-chip"
            :aria-label="`编辑标签「${tag.name}」`"
            @click="editing = tag"
          >
            {{ tag.name
            }}<svg
              viewBox="0 0 24 24"
              width="14"
              height="14"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M4 20h4L19 9l-4-4L4 16z" />
            </svg>
          </button>
        </div>
        <TagChips
          v-else-if="tags.length"
          v-model="tagFilter"
          label="标签筛选"
          all-label="全部"
          :tags="tags"
        />
        <p v-if="tagError" class="tag-error" role="alert">
          {{ tagError }}
          <button type="button" class="retry" @click="loadTags">重试</button>
        </p>
      </div>
      <template v-if="posts">
        <MultiSelect
          v-if="!withinProfile"
          v-model="form.authors"
          label="作者"
          remote
          :options="authorOptions"
          :names="authorNames"
          :loading="authorsLoading"
          :more="!!authorsNext"
          @open="openAuthors"
          @search="searchAuthors"
          @more="loadAuthors(true)"
        />
        <p v-if="!withinProfile && authorError" class="hint" role="alert">
          {{ authorError }}
          <button type="button" class="retry" @click="loadAuthors()">
            重试
          </button>
        </p>
        <MultiSelect
          v-model="form.media"
          label="媒体类型"
          :options="mediaOptions"
          :searchable="false"
        />
      </template>
      <label v-if="posts" class="option"
        >帖子类型<span class="select"
          ><select v-model="form.postType" aria-label="帖子类型">
            <option value="">全部</option>
            <option value="post">贴文</option>
            <option value="quote">引用</option>
            <option value="repost">转发</option></select
          ><ChevronIcon class="select-chevron" /></span
      ></label>
      <label class="option"
        >{{ posts ? '作者可见性' : '可见性'
        }}<span class="select"
          ><select
            v-model="form.visibility"
            :aria-label="posts ? '作者可见性' : '可见性'"
          >
            <option value="">全部</option>
            <option value="public">公开</option>
            <option value="private">私密</option></select
          ><ChevronIcon class="select-chevron" /></span
      ></label>
      <label v-if="posts" class="option"
        >敏感内容<span class="select"
          ><select v-model="form.sensitive" aria-label="敏感内容">
            <option value="">全部</option>
            <option value="contains">包含</option>
            <option value="not_contains">不包含</option></select
          ><ChevronIcon class="select-chevron" /></span
      ></label>
      <label class="option"
        >收藏日期<span class="select"
          ><select v-model="range" aria-label="收藏日期">
            <option value="">全部</option>
            <option
              v-for="option in rangeOptions"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
            <option value="custom">自定义</option></select
          ><ChevronIcon class="select-chevron" /></span
      ></label>
      <div
        v-if="range === 'custom'"
        class="option dates"
        role="group"
        aria-label="自定义收藏日期"
      >
        起止日期<span class="range"
          ><input
            v-model="form.from"
            type="date"
            aria-label="收藏开始日期" /><span aria-hidden="true">–</span
          ><input
            v-model="form.to"
            type="date"
            :min="form.from"
            aria-label="收藏结束日期"
        /></span>
      </div>
    </div>
  </form>
  <!-- Only while editing: most lists never manage their tags. -->
  <TagEditSheet
    v-if="managing"
    :tag="editing"
    :tags="tags"
    @changed="tagChanged"
    @close="editing = undefined"
  />
</template>

<style scoped>
.filters {
  padding: 8px var(--gutter) 4px;
}
.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--fill);
  border-radius: var(--radius);
  padding-inline: 12px;
}
.glass {
  display: block;
  flex: none;
  width: 18px;
  height: 18px;
  color: var(--subtle);
}
.field {
  flex: 1;
  min-width: 0;
  min-height: 40px;
  border: 0;
  background: none;
  font-size: 16px;
  outline-offset: -2px;
}
.field::placeholder {
  color: var(--subtle);
}
.field::-webkit-search-cancel-button {
  filter: grayscale(1) opacity(0.6);
}
.submit {
  flex-shrink: 0;
  min-height: 40px;
  padding-left: 4px;
  font-size: 15px;
  color: var(--link);
}
.toggles {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 40px;
  font-size: 14px;
  white-space: nowrap;
}
.toggle {
  display: flex;
  align-items: center;
  min-width: 0;
  min-height: 40px;
  padding: 0 4px;
  color: var(--link);
}
.reset {
  flex: none;
  color: var(--subtle);
}
.filter-summary {
  margin: -4px 0 6px;
  padding: 0 4px;
  color: var(--subtle);
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.sort {
  display: flex;
  flex: none;
  gap: 8px;
  margin-left: auto;
}
.sort .select {
  max-width: none;
}
.sort select {
  min-height: 40px;
  border: 0;
  background: none;
  color: var(--link);
  font: inherit;
}
.hint {
  margin: 0;
  padding: 0 var(--inset) 10px;
  color: var(--subtle);
  font-size: 12px;
  line-height: 1.5;
}
.tag-filter {
  padding: 10px var(--inset) 12px;
}
.tag-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 0 0 8px;
  font-size: 15px;
}
.manage {
  min-height: 32px;
  padding: 0 4px;
  color: var(--link);
  font-size: 14px;
}
/* Same pills as the picker, so editing reads as the same list. */
.tag-edit {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  max-height: 228px;
  margin: -6px -4px;
  padding: 6px 4px;
  overflow: auto;
  overscroll-behavior: contain;
}
.tag-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  min-height: 34px;
  padding: 6px 13px;
  border-radius: 999px;
  background: var(--fill);
  font-size: 14px;
  line-height: 1.3;
  text-align: start;
  overflow-wrap: anywhere;
}
.tag-chip svg {
  flex: none;
  color: var(--subtle);
}
.tag-error {
  margin: 10px 0 0;
  color: var(--subtle);
  font-size: 13px;
  line-height: 1.5;
}
.retry {
  min-height: 32px;
  color: var(--link);
}
.panel {
  background: var(--card);
  border-radius: var(--radius);
  margin-top: 2px;
  overflow: hidden;
}
.option {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 44px;
  padding: 2px var(--inset);
  font-size: 15px;
  white-space: nowrap;
}
.panel > * {
  position: relative;
}
/* Rows of every kind share one inset hairline, as in a grouped list. */
.panel > * + *::before {
  content: '';
  position: absolute;
  inset: 0 0 auto var(--inset);
  height: 1px;
  background: var(--separator);
}
.option select,
.option input {
  min-height: 36px;
  min-width: 0;
  border: 0;
  background: none;
  color: var(--link);
  font-size: 15px;
  text-align: right;
}
/* Both ends share the row with their label while they fit; on a narrow
   screen the range drops below it rather than cutting dates short. */
.dates {
  flex-wrap: wrap;
  row-gap: 0;
}
.range {
  display: flex;
  flex: 1 0 15.5em;
  justify-content: flex-end;
  align-items: center;
  gap: 4px;
  min-width: 0;
  color: var(--subtle);
}
.range input {
  flex: 0 1 8.5em;
}
/* The chevron owns a reserved gutter, so no arrow ever crowds its own label. */
.select {
  position: relative;
  display: inline-flex;
  align-items: center;
  min-width: 0;
  max-width: 60%;
}
.select select {
  appearance: none;
  -webkit-appearance: none;
  max-width: 100%;
  padding-right: 26px;
}
.select-chevron {
  position: absolute;
  right: 0;
  top: calc(50% - 12px);
  pointer-events: none;
}
</style>
