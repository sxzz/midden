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
import { listSort, listsProfiles, searches } from '../presentation'
import { composeQuery, hasTerms, readQuery, splitQuery } from '../query'
import { readAuthors } from '../reads'
import { defaultRelMin, isRel, relMinOf, type Rel } from '../relation-filter'
import { shareSlug } from '../share'
import QueryBox from './QueryBox.vue'
import RelationFilter from './RelationFilter.vue'
import TagEditSheet from './TagEditSheet.vue'
import ChevronIcon from './ui/ChevronIcon.vue'
import MultiSelect from './ui/MultiSelect.vue'
import TagFilterChips from './ui/TagFilterChips.vue'
const tags = shallowRef<Tag[]>([])
const tagError = shallowRef('')
// Behind a public link there are no tags, save dates or sizes to offer:
// they are the owner's, and the share refuses filtering or sorting by them.
// Nor follows (关系): their accounts reach beyond the share.
const shared = !!shareSlug.value
async function loadTags() {
  if (shared) return
  try {
    tags.value = await call(client.tags.$get())
    tagError.value = ''
  } catch (e) {
    tagError.value = errorText(e)
  }
}
onMounted(async () => {
  await loadTags()
  absorb()
})
onActivated(loadTags)
const props = defineProps<{
  query: string
  /** One account's own list: its platform and author are given. */
  withinProfile?: boolean
  /**
   * A folder's list: its filter covers posts and accounts alike, and the
   * folder's tab (`tab`) shows one of them, where a home tab's list is one
   * kind by its entity types.
   */
  folder?: boolean
}>()
const emit = defineEmits<{
  /** `replace`: the same list, said by the controls where they can. */
  search: [query: string, replace?: boolean]
  /** A tag was renamed, merged into another or deleted. */
  tagsChanged: [change: TagChange]
}>()
/** The one value all of these share, or nothing. */
function only<T extends string>(items: T[]): T | '' {
  return items.length && items.every((item) => item === items[0])
    ? items[0]!
    : ''
}
const ids = (raw: string | null) => (raw ? raw.split(',') : [])
/** Which follows the 关系 filter takes; none behind a share. */
function relMode(params: URLSearchParams): Rel | '' {
  const rel = params.get('rel')
  return !shared && isRel(rel) ? rel : ''
}
/** A threshold the address sets apart from the default, else 0. */
function relMinParam(params: URLSearchParams): number {
  const count = new Set(params.getAll('rel_of').filter(Boolean)).size
  const min = relMinOf(params.get('rel_min'), count)
  return min === defaultRelMin(count) ? 0 : min
}
function read(query: string) {
  const params = new URLSearchParams(query)
  const types = (params.get('entity_type') || '').split(',').filter(Boolean)
  const platform = only(types.map((type) => type.split('.')[0] || ''))
  return {
    /** Tags wanted, any of them unless `tagMode` is `all`. */
    tag: shared ? [] : ids(params.get('tag')),
    tagMode: !shared && params.get('tag_mode') === 'all' ? 'all' : '',
    /** Tags none of which may be there. */
    notTag: shared ? [] : ids(params.get('not_tag')),
    /** The accounts whose follows select, which of them, and how many. */
    relOf: shared ? [] : [...new Set(params.getAll('rel_of').filter(Boolean))],
    rel: relMode(params),
    /** 0 for the default. */
    relMin: shared ? 0 : relMinParam(params),
    postType: params.get('post_type') || '',
    authors: params.getAll('author'),
    layout: params.get('layout') === 'album' ? 'album' : '',
    order: params.get('order') || 'desc',
    sort: listSort(params),
    q: params.get('q') || '',
    // Which tab this form belongs to; it rides along.
    entity: params.get('entity_type') || '',
    kind: only(types.map(kindOf)),
    /** The kind a folder holding both shows; it rides along. */
    tab: params.get('tab') || '',
    platform: platform === 'x' || platform === 'instagram' ? platform : '',
    media: (params.get('media_type') || '').split(',').filter(Boolean),
    visibility: params.get('visibility') || '',
    sensitive: params.get('sensitive') || '',
    /** What the platform now says of it: `deleted` or `suspended`. */
    sourceState: params.get('source_state') || '',
    from: (!shared && params.get('from_date')) || '',
    to: (!shared && params.get('to_date')) || '',
    /** A relative range such as `7d`, counted again on every visit. */
    within: (!shared && params.get('saved_within')) || '',
    /** Where its days are counted, when not this browser's zone. */
    zone: (!shared && params.get('tz')) || '',
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
/** The order a list of this kind has by default, searching `q` or not. */
const defaultSort = (f: Form, q = f.q) =>
  listSort(new URLSearchParams({ tab: shownKind(f), q }))
/** How the two directions of the chosen order read. */
const orderNames = computed(() =>
  form.sort === 'storage'
    ? { desc: '从大到小', asc: '从小到大' }
    : form.sort === 'followers' || form.sort === 'following'
      ? { desc: '从多到少', asc: '从少到多' }
      : { desc: '从新到旧', asc: '从旧到新' },
)
/**
 * The entity types the form selects. A home tab's kind is fixed and its
 * posts are the default, left out of the address; a folder covers both
 * kinds, so only a platform names any.
 */
function entityTypes(f: Form) {
  if (props.folder && !f.platform) return ''
  if (!props.folder && f.kind !== 'profile' && !f.platform) return ''
  const kinds = props.folder ? KINDS : f.kind ? [f.kind] : ['post']
  const platforms = f.platform ? [f.platform] : ['x', 'instagram']
  return kinds
    .flatMap((kind) => platforms.map((name) => `${name}.${kind}`))
    .join(',')
}
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
/** 原站状态 as each tab names it: posts deleted, accounts suspended. */
const sourceStateNames = computed<Record<string, string>>(() =>
  posts.value
    ? { deleted: '原站已删除的帖子', suspended: '作者被封禁的帖子' }
    : { suspended: '被封禁的账号', deleted: '已不存在的账号' },
)
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
  return days === 1 ? '今天' : days > 1 ? `最近${days}天` : ''
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
    form.tag.length ||
    form.notTag.length ||
    form.relOf.length ||
    form.authors.length ||
    form.media.length ||
    form.visibility ||
    form.sensitive ||
    form.sourceState ||
    form.from ||
    form.to ||
    form.within
  ),
)
const active = computed(() =>
  [
    form.platform ? (form.platform === 'instagram' ? 'Instagram' : 'X') : '',
    tagSummary.value,
    relationSummary.value,
    form.media.map((type) => mediaNames[type]).join('、'),
    // Authors are selected by identity; only their names are worth showing.
    form.authors.map((id) => authorNames.value[id] || id).join('、'),
    postTypeNames[form.postType],
    visibilityNames[form.visibility],
    sensitiveNames[form.sensitive],
    sourceStateNames.value[form.sourceState],
    withinLabel(form.within) ||
      (form.from && form.to
        ? `${form.from}至${form.to}`
        : form.from
          ? `${form.from}起`
          : form.to
            ? `${form.to}前`
            : ''),
    // Terms of the query no control shows.
    !shared && hasTerms(form.q) ? '自定义' : '',
  ]
    .filter(Boolean)
    .join(' · '),
)
function stringify(f: Form) {
  const q = new URLSearchParams()
  for (const [k, v] of [
    // Sets of ids, written in order the way a folder stores them.
    ['tag', f.tag.toSorted().join(',')],
    ['tag_mode', f.tag.length > 1 ? f.tagMode : ''],
    ['not_tag', f.notTag.toSorted().join(',')],
    ['rel', f.relOf.length ? f.rel : ''],
    [
      'rel_min',
      f.rel && f.relOf.length > 1 && f.relMin ? String(f.relMin) : '',
    ],
    ['post_type', f.postType],
    ['q', f.q],
    ['layout', f.layout],
    ['tab', f.tab],
    // The default order stays out of the address; relevance is the default
    // and only means something while searching.
    ['sort', f.sort === defaultSort(f) || f.sort === 'relevance' ? '' : f.sort],
    // Relevance has no direction.
    ['order', f.order === 'desc' || f.sort === 'relevance' ? '' : f.order],
    ['media_type', f.media.join(',')],
    ['visibility', f.visibility],
    ['sensitive', f.sensitive],
    ['source_state', f.sourceState],
    ['from_date', f.from],
    ['to_date', f.to],
    ['saved_within', f.within],
    ['tz', f.within ? f.zone : ''],
    ['entity_type', entityTypes(f)],
  ])
    if (v) q.set(k, v)
  for (const author of f.authors) q.append('author', author)
  if (f.rel) for (const key of f.relOf) q.append('rel_of', key)
  return q.toString()
}
const build = () => stringify(form)
/** The last query this component and its parent agree on, canonicalised so
    neither the auto-search watcher nor the `query` sync can echo one back —
    the router may re-encode or reorder what we emitted. */
let settled = build()
/** Whether the list shown searches; 相关度 is offered only then. */
const searching = shallowRef(searches(settled))
/** A range the user is still halfway through typing is not a filter yet. */
const usable = () => !form.from || !form.to || !(form.from > form.to)
function search() {
  if (!usable()) return
  // Starting or ending a search moves a default order to the new default;
  // an order the user chose stays.
  const before = new URLSearchParams(settled).get('q') || ''
  if (form.sort === defaultSort(form, before)) form.sort = defaultSort(form)
  else if (form.sort === 'relevance' && !form.q.trim())
    form.sort = defaultSort(form)
  const query = build()
  searching.value = searches(query)
  recompose()
  if (query === settled) return
  settled = query
  emit('search', query)
}

// --- The query box ----------------------------------------------------------
// The owner's box shows the whole query: the search's own terms (`q`) and
// the controls' as terms. Submitted, each term a control says goes to it
// and the rest stays the search's, so the box and the controls are one
// list either way. Behind a share the box is a plain keyword search.
const tagName = (id: string) => tags.value.find((tag) => tag.id === id)?.name
const tagId = (ref: string) =>
  tags.value.find((tag) => tag.id === ref.toLowerCase() || tag.name === ref)?.id
/** The terms the box writes for authors (`from:@alice`), by key. */
const authorTerms = shallowRef<Record<string, string>>({})
const authorKeyOf = (term: string) =>
  Object.entries(authorTerms.value).find(([, t]) => t === term)?.[0]
const compose = () =>
  composeQuery(form.q, form, {
    tagName,
    authorTerm: (key) => authorTerms.value[key],
  })
const boxText = shallowRef(compose())
/** What the box was last given; anything else there is being typed. */
let composed = boxText.value
function recompose() {
  composed = compose()
  boxText.value = composed
}
// Tags read by name and authors by handle once they are known, unless the
// box is being edited.
watch([tags, authorTerms], () => {
  if (boxText.value === composed) recompose()
})
const NO_CONTROLS = {
  platform: '',
  tag: [],
  tagMode: '',
  notTag: [],
  relOf: [],
  rel: '',
  relMin: 0,
  postType: '',
  authors: [],
  media: [],
  visibility: '',
  sensitive: '',
  sourceState: '',
  from: '',
  to: '',
  within: '',
  zone: '',
} as const
function submitQuery(text: string) {
  const { node, error } = readQuery(text)
  if (error) return
  const { controls, q } = splitQuery(node, tagId, authorKeyOf)
  Object.assign(form, structuredClone(NO_CONTROLS), controls, { q })
  customRange.value = !form.within && !!(form.from || form.to)
  search()
}
/**
 * A query that arrives whole (from the sidebar, a link) moves its terms to
 * the controls that say them, in place of the address it came with. Not in
 * a folder, whose saved query is shown as it was saved.
 */
function absorb() {
  if (shared || props.folder) return
  const { node, error } = readQuery(form.q)
  if (error || !node) return
  const { controls, q } = splitQuery(node, tagId, authorKeyOf)
  const fields = Object.keys(controls) as (keyof typeof controls)[]
  if (!fields.length) return
  // Only into controls the address leaves empty.
  const empty = (value: unknown) =>
    Array.isArray(value) ? !value.length : !value
  if (!fields.every((field) => empty(form[field]))) return
  Object.assign(form, controls, { q })
  if (form.from || form.to) customRange.value = true
  const query = build()
  settled = query
  searching.value = searches(query)
  recompose()
  emit('search', query, true)
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
  searching.value = false
  recompose()
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
    form.tag.join(','),
    form.tagMode,
    form.notTag.join(','),
    form.relOf.join('\n'),
    form.rel,
    form.relMin,
    form.sort,
    form.order,
    form.visibility,
    form.sensitive,
    form.sourceState,
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
    searching.value = searches(settled)
    Object.assign(form, incoming)
    if (incoming.within || (!incoming.from && !incoming.to))
      customRange.value = false
    recompose()
    absorb()
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
  const terms = items.filter(
    (a) => a.term && authorTerms.value[a.id] !== a.term,
  )
  if (terms.length)
    authorTerms.value = {
      ...authorTerms.value,
      ...Object.fromEntries(terms.map((a) => [a.id, a.term!])),
    }
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
    const data = await readAuthors(
      {
        q: authorQuery.value.trim() || undefined,
        cursor: more ? authorsNext.value : undefined,
      },
      controller.signal,
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
        (await readAuthors({ author: missing }, controller.signal)).items,
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
  const swap = (list: string[]) => [
    ...new Set(
      list.flatMap((id) =>
        id !== change.from ? [id] : change.to ? [change.to.id] : [],
      ),
    ),
  ]
  const tag = swap(form.tag)
  const notTag = swap(form.notTag).filter((id) => !tag.includes(id))
  if (tag.join() !== form.tag.join()) form.tag = tag
  if (notTag.join() !== form.notTag.join()) form.notTag = notTag
}
/** The 关系 filter in words, from its section, which knows the names. */
const relationSummary = shallowRef('')
/** Tags read by name; one no longer listed has none to show. */
const tagSummary = computed(() => {
  const wanted = form.tag.map(tagName).filter(Boolean)
  return [
    wanted.join(form.tagMode === 'all' ? ' 且 ' : '、'),
    ...form.notTag
      .map(tagName)
      .filter(Boolean)
      .map((name) => `非 ${name}`),
  ]
    .filter(Boolean)
    .join('、')
})
</script>

<template>
  <form class="filters" @submit.prevent="search">
    <QueryBox v-if="!shared" v-model="boxText" @submit="submitQuery" />
    <div v-else class="bar">
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
            <option v-if="searching" value="relevance">相关度</option>
            <option v-if="posts" value="published">发帖时间</option>
            <option v-if="!shared" value="saved">添加时间</option>
            <option value="updated">更新时间</option>
            <option v-if="!shared" value="storage">存储空间</option>
            <template v-if="!posts">
              <option value="followers">粉丝数</option>
              <option value="following">关注数</option>
            </template></select
          ><ChevronIcon class="select-chevron" /></span
        ><span v-if="form.sort !== 'relevance'" class="select"
          ><select v-model="form.order" aria-label="排序方向">
            <option value="desc">{{ orderNames.desc }}</option>
            <option value="asc">{{ orderNames.asc }}</option></select
          ><ChevronIcon class="select-chevron" /></span
      ></span>
    </div>
    <!-- On its own line: beside the sort pickers a phone has room for a
         word or two of it. -->
    <p v-if="active" class="filter-summary">{{ active }}</p>
    <div v-show="open" class="panel">
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
           collection itself, not a picker that hides them. A tap wants a
           tag, a second excludes it, a third lets it go. -->
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
        <template v-else-if="tags.length">
          <TagFilterChips
            v-model:include="form.tag"
            v-model:exclude="form.notTag"
            label="标签筛选"
            :tags="tags"
          />
          <!-- How several wanted tags combine; one needs no choice. -->
          <div
            v-if="form.tag.length > 1"
            class="tag-mode"
            role="radiogroup"
            aria-label="标签匹配方式"
          >
            <label
              ><input v-model="form.tagMode" type="radio" value="" /><span
                >任一</span
              ></label
            ><label
              ><input v-model="form.tagMode" type="radio" value="all" /><span
                >全部</span
              ></label
            >
          </div>
        </template>
        <p v-if="tagError" class="tag-error" role="alert">
          {{ tagError }}
          <button type="button" class="retry" @click="loadTags">重试</button>
        </p>
      </div>
      <RelationFilter
        v-if="!shared"
        v-model:rel-of="form.relOf"
        v-model:rel="form.rel"
        v-model:rel-min="form.relMin"
        @summary="(text) => (relationSummary = text)"
      />
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
      <!-- Public on the platform, so a share filters by it too. -->
      <label class="option"
        >原站状态<span class="select"
          ><select v-model="form.sourceState" aria-label="原站状态">
            <option value="">全部</option>
            <option
              v-for="(name, value) in sourceStateNames"
              :key="value"
              :value="value"
            >
              {{ name }}
            </option></select
          ><ChevronIcon class="select-chevron" /></span
      ></label>
      <label v-if="!shared" class="option"
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
/* A segmented pair under the chips, as small as the choice it makes. */
.tag-mode {
  display: inline-flex;
  gap: 2px;
  margin-top: 12px;
  padding: 2px;
  border-radius: 9px;
  background: var(--fill);
}
.tag-mode label {
  position: relative;
  cursor: pointer;
}
.tag-mode input {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: 0;
  overflow: hidden;
  clip-path: inset(50%);
}
.tag-mode span {
  display: block;
  min-width: 56px;
  padding: 5px 12px;
  border-radius: 7px;
  font-size: 13px;
  text-align: center;
}
.tag-mode input:checked + span {
  background: var(--card);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
  font-weight: 600;
}
.tag-mode input:focus-visible + span {
  outline: 2px solid var(--link);
  outline-offset: 1px;
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
