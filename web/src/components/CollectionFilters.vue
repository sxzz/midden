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
import { api, errorText, type Author, type Tag } from '../api'
import ChevronIcon from './ui/ChevronIcon.vue'
import MultiSelect from './ui/MultiSelect.vue'
import TagChips from './ui/TagChips.vue'
const tags = shallowRef<Tag[]>([])
const tagError = shallowRef('')
async function loadTags() {
  try {
    tags.value = await api<Tag[]>('/tags')
    tagError.value = ''
  } catch (e) {
    tagError.value = errorText(e)
  }
}
onMounted(loadTags)
onActivated(loadTags)
const props = defineProps<{ query: string }>()
const emit = defineEmits<{ search: [query: string] }>()
function read(query: string) {
  const params = new URLSearchParams(query)
  return {
    tag: params.get('tag') || '',
    authors: params.getAll('author'),
    layout: params.get('layout') === 'album' ? 'album' : '',
    order: params.get('order') || 'desc',
    sort: params.get('sort') || 'captured',
    q: params.get('q') || '',
    // Which tab this form belongs to; it rides along but is never edited here.
    entity: params.get('entity_type') === 'x.profile' ? 'x.profile' : '',
    media: (params.get('media_type') || '').split(',').filter(Boolean),
    visibility: params.get('visibility') || '',
    sensitive: params.get('sensitive') || '',
    from: params.get('from_date') || '',
    to: params.get('to_date') || '',
  }
}
type Form = ReturnType<typeof read>
const form = reactive(read(props.query))
// Authors, media and sensitivity describe posts; an account has none of them.
const posts = computed(() => !form.entity)
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
const open = shallowRef(
  !!(
    form.tag ||
    form.authors.length ||
    form.media.length ||
    form.visibility ||
    form.sensitive ||
    form.from ||
    form.to
  ),
)
const active = computed(() =>
  [
    form.tag
      ? tags.value.find((tag) => tag.id === form.tag)?.name || '已选标签'
      : '',
    form.media.map((type) => mediaNames[type]).join('、'),
    // Authors are selected by identity; only their names are worth showing.
    form.authors.map((id) => authorNames.value[id] || id).join('、'),
    visibilityNames[form.visibility],
    sensitiveNames[form.sensitive],
    form.from && form.to
      ? `${form.from} 至 ${form.to}`
      : form.from
        ? `${form.from} 起`
        : form.to
          ? `${form.to} 前`
          : '',
  ]
    .filter(Boolean)
    .join(' · '),
)
function stringify(f: Form) {
  const q = new URLSearchParams()
  for (const [k, v] of [
    ['tag', f.tag],
    ['q', f.q],
    ['layout', f.layout],
    ['sort', f.sort],
    ['order', f.order],
    ['media_type', f.media.join(',')],
    ['visibility', f.visibility],
    ['sensitive', f.sensitive],
    ['from_date', f.from],
    ['to_date', f.to],
    ['entity_type', f.entity],
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
  const { layout, entity } = form
  Object.assign(form, read(''), { layout, entity })
  settled = build()
  const q = new URLSearchParams()
  if (layout) q.set('layout', layout)
  if (entity) q.set('entity_type', entity)
  emit('search', q.toString())
}
/** The tab itself is not a filter, so it alone leaves nothing to clear. */
const clearable = computed(() => {
  const q = new URLSearchParams(props.query)
  q.delete('entity_type')
  return q.size > 0
})
// Every discrete control applies itself; only the keyword box waits for Enter.
watch(
  () => [
    form.tag,
    form.sort,
    form.order,
    form.visibility,
    form.sensitive,
    form.from,
    form.to,
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
  },
)
const authors = shallowRef<Author[]>([])
const authorError = shallowRef('')
const authorsLoading = shallowRef(false)
let authorsLoaded = false
const controller = new AbortController()
onUnmounted(() => controller.abort())
async function loadAuthors() {
  if (authorsLoading.value) return
  authorsLoading.value = true
  authorError.value = ''
  try {
    const data = await api<{ items: Author[] }>('/collections/authors', {
      signal: controller.signal,
    })
    authors.value = data.items.filter(
      (author) => typeof author?.id === 'string' && author.id,
    )
    authorsLoaded = true
  } catch (error) {
    if (!controller.signal.aborted) authorError.value = errorText(error)
  } finally {
    authorsLoading.value = false
  }
}
watch(
  open,
  (value) => {
    if (value && posts.value && !authorsLoaded) void loadAuthors()
  },
  { immediate: true },
)
// Two accounts may share a display name, so the label is never the value.
const authorOptions = computed(() =>
  authors.value.map((author) => ({
    value: author.id,
    label: author.name || author.id,
  })),
)
const authorNames = computed(() =>
  Object.fromEntries(
    authors.value.map((author) => [author.id, author.name || author.id]),
  ),
)
const mediaOptions = Object.entries(mediaNames).map(([value, label]) => ({
  value,
  label,
}))
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
        筛选<span v-if="active" class="separator" aria-hidden="true">·</span
        ><span v-if="active" class="active">{{ active }}</span>
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
          ><select
            :value="form.sort"
            aria-label="排序"
            @change="form.sort = ($event.target as HTMLSelectElement).value"
          >
            <option value="captured">采集时间</option>
            <option v-if="posts" value="published">发帖时间</option>
            <option value="storage">存储空间</option></select
          ><ChevronIcon class="select-chevron" /></span
        ><span class="select"
          ><select
            :value="form.order"
            aria-label="排序方向"
            @change="form.order = ($event.target as HTMLSelectElement).value"
          >
            <option value="desc">
              {{ form.sort === 'storage' ? '从大到小' : '从新到旧' }}
            </option>
            <option value="asc">
              {{ form.sort === 'storage' ? '从小到大' : '从旧到新' }}
            </option></select
          ><ChevronIcon class="select-chevron" /></span
      ></span>
    </div>
    <div v-show="open" class="panel">
      <!-- Tags are your own vocabulary, so they get the same chips as in the
           collection itself, not a picker that hides them. -->
      <div v-if="tags.length || tagError" class="tag-filter">
        <p class="tag-title">标签</p>
        <TagChips
          v-if="tags.length"
          v-model="tagFilter"
          label="标签筛选"
          all-label="全部"
          :tags="tags"
        />
        <p v-if="tagError" class="tag-error" role="alert">
          {{ tagError }}
          <button type="button" class="tag-retry" @click="loadTags">
            重试
          </button>
        </p>
      </div>
      <template v-if="posts">
        <MultiSelect
          v-model="form.authors"
          label="作者"
          :options="authorOptions"
        />
        <p v-if="authorsLoading" class="hint" role="status">正在加载作者…</p>
        <p v-if="authorError" class="hint" role="alert">
          {{ authorError }}
          <button type="button" @click="loadAuthors">重试</button>
        </p>
        <MultiSelect
          v-model="form.media"
          label="媒体类型"
          :options="mediaOptions"
          :searchable="false"
        />
      </template>
      <label class="option"
        >可见性<span class="select"
          ><select v-model="form.visibility">
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
      <div class="option dates" role="group" aria-label="收藏日期">
        收藏日期<span class="range"
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
.separator {
  color: var(--subtle);
  padding-inline: 6px;
}
.active {
  color: var(--subtle);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  border-bottom: 1px solid var(--separator);
}
.tag-title {
  margin: 0 0 8px;
  font-size: 15px;
}
.tag-error {
  margin: 10px 0 0;
  color: var(--subtle);
  font-size: 13px;
  line-height: 1.5;
}
.tag-retry {
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
.option + .option::before {
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
