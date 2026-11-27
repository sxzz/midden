<script setup vapor lang="ts">
// The owner's search box: a query of the query language (`query.ts`), read
// as it is typed. A query it cannot read shows why, and where; one it reads
// differently from how it is written shows how. Terms are completed from
// the keys, their fixed values, and what the library holds (handles, tags,
// folders, hashtags, domains), in a dropdown under the text. `?` lists the
// terms. Enter (the keyboard's 搜索 key on a phone) runs the query.
import {
  computed,
  onUnmounted,
  shallowRef,
  useId,
  useTemplateRef,
  watch,
} from 'vue'
import { call, client } from '../api'
import { useAnchoredPopover } from '../composables/useAnchoredPopover'
import {
  completing,
  KEYS,
  quoteValue,
  readQuery,
  type Completing,
} from '../query'
import QueryHelp from './QueryHelp.vue'
import QueryTerm from './QueryTerm.vue'
withDefaults(defineProps<{ placeholder?: string; label?: string }>(), {
  placeholder: '搜索收藏',
  label: '搜索或筛选',
})
const text = defineModel<string>({ required: true })
const emit = defineEmits<{ submit: [query: string] }>()
const AT = /^@/
/** Text a new term starts right after: nothing, a space or a ( . */
const OPEN_END = /[\s(]$/
const id = useId()
const input = useTemplateRef<HTMLInputElement>('input')
const bar = useTemplateRef<HTMLElement>('bar')
const list = useTemplateRef<HTMLElement>('list')
const helpButton = useTemplateRef<HTMLElement>('helpButton')
const read = computed(() => readQuery(text.value))
const error = computed(() => (text.value.trim() ? read.value.error : undefined))
/** How the query reads, when that is not how it is written. */
const parsed = computed(() =>
  !error.value && read.value.parsed && read.value.parsed !== text.value.trim()
    ? read.value.parsed
    : '',
)
/** The query around the error, the place itself marked. */
const marked = computed(() => {
  const at = error.value?.position ?? 0
  return {
    before: text.value.slice(Math.max(0, at - 24), at),
    at: text.value.slice(at, at + 1) || ' ',
    after: text.value.slice(at + 1, at + 25),
  }
})

/** What each key selects, beside it in the dropdown. */
const KEY_TEXT: Record<string, string> = {
  from: '作者',
  mentions: '提到',
  quotes: '引用其帖子',
  reposts: '转发其帖子',
  'reposted-by': '转发者',
  protected: '私密账号',
  related: '相关的收藏',
  rel: '关注关系',
  is: '帖子类型',
  has: '媒体或链接',
  domain: '链接域名',
  lang: '语言',
  platform: '平台',
  since: '发帖日期起',
  until: '发帖日期前',
  within: '最近发帖',
  saved: '收藏时间',
  'saved-since': '收藏日期起',
  'saved-until': '收藏日期前',
  tag: '标签',
  folder: '收藏夹',
  state: '原站状态',
  type: '帖子或账号',
  sensitive: '敏感内容',
}
/** What each fixed value means. */
const VALUE_TEXT: Record<string, string> = {
  original: '原创',
  quote: '引用',
  repost: '转发',
  image: '图片',
  video: '视频',
  media: '图片或视频',
  link: '链接',
  post: '帖子',
  profile: '账号',
  deleted: '原站已删除',
  suspended: '被封禁',
  yes: '是',
  no: '否',
  x: 'X',
  instagram: 'Instagram',
  ja: '日语',
  zh: '中文',
  ko: '韩语',
  en: '英语',
  es: '西班牙语',
  fr: '法语',
  de: '德语',
  pt: '葡萄牙语',
  'following:': '关注的',
  'followers:': '粉丝',
  'mutual:': '互关',
}

interface Option {
  /** What replaces the term at the caret. */
  insert: string
  /** The term as it will read, coloured by its grammar. */
  term: string
  detail?: string
}
interface Suggestion {
  value: string
  label?: string
  count?: number
}
const options = shallowRef<Option[]>([])
const active = shallowRef(-1)
let target: Completing | undefined
/** What the library offered, by kind and prefix. */
const cache = new Map<string, Suggestion[]>()
let asked = 0
let timer: ReturnType<typeof setTimeout> | undefined
onUnmounted(() => clearTimeout(timer))

/** What completes the term at the caret, at once or after a short pause. */
function complete() {
  const el = input.value
  if (!el || document.activeElement !== el) return close()
  // The field itself: the model follows it a render later.
  const caret = el.selectionStart ?? el.value.length
  target = completing(el.value, caret, KEYS)
  clearTimeout(timer)
  const c = target
  if (!c) return close()
  const done = (insert: string): Option => ({
    insert: `${c.lead}${insert}`,
    term: `${c.lead}${insert}`.trimEnd(),
  })
  if (c.source.kind === 'keys') {
    const prefix = c.prefix.toLowerCase()
    return show(
      KEYS.filter((k) => k.startsWith(prefix)).map((k) => ({
        ...done(`${k}:`),
        detail: KEY_TEXT[k],
      })),
    )
  }
  if (c.source.kind === 'values') {
    const prefix = c.prefix.toLowerCase()
    return show(
      c.source.values
        .filter((v) => v.startsWith(prefix) && v !== prefix)
        .map((v) => ({
          ...done(v.endsWith(':') ? v : `${v} `),
          detail: VALUE_TEXT[v],
        })),
    )
  }
  const { remote } = c.source
  // A handle is completed without its `@`; the rest as typed.
  const prefix = remote === 'handle' ? c.prefix.replace(AT, '') : c.prefix
  const key = `${remote}\n${prefix}`
  const quoted = c.lead.endsWith('"')
  const toOption = (item: Suggestion): Option => {
    const value = quoted
      ? `${item.value.replaceAll('"', '""')}" `
      : `${remote === 'handle' || remote === 'hashtag' ? item.value : quoteValue(item.value)} `
    const counted = item.count === undefined ? '' : `${item.count} 条`
    return {
      ...done(value),
      detail:
        remote === 'handle'
          ? [item.label, counted].filter(Boolean).join(' · ')
          : counted,
    }
  }
  const known = cache.get(key)
  if (known) return show(known.map(toOption))
  // Until they come, offer nothing: the last values were for another prefix.
  close()
  const version = ++asked
  timer = setTimeout(async () => {
    try {
      const { items } = await call(
        client.query.suggest.$get({ query: { kind: remote, prefix } }),
      )
      cache.set(key, items)
      if (version === asked && target === c) show(items.map(toOption))
    } catch {
      // Nothing to offer; the query still reads.
    }
  }, 120)
}
function show(found: Option[]) {
  options.value = found
  active.value = found.length ? 0 : -1
}
function close() {
  options.value = []
  active.value = -1
}
/** Put text in the field at once, caret and all; the model follows. */
function put(value: string, caret: number) {
  const el = input.value
  if (!el) return
  el.value = value
  if (document.activeElement !== el) el.focus()
  el.setSelectionRange(caret, caret)
  text.value = value
}
function accept(option: Option) {
  const c = target
  const el = input.value
  if (!c || !el) return
  put(
    el.value.slice(0, c.start) + option.insert + el.value.slice(c.end),
    c.start + option.insert.length,
  )
  close()
  // The next term may be completed in turn.
  complete()
}
function keydown(event: KeyboardEvent) {
  const open = options.value.length > 0
  if (event.key === 'ArrowDown' && open) {
    event.preventDefault()
    active.value = (active.value + 1) % options.value.length
  } else if (event.key === 'ArrowUp' && open) {
    event.preventDefault()
    active.value =
      (active.value - 1 + options.value.length) % options.value.length
  } else if ((event.key === 'Enter' || event.key === 'Tab') && open) {
    const option = options.value[active.value]
    if (!option) return
    event.preventDefault()
    accept(option)
  } else if (event.key === 'Escape') {
    // Closes the list; never empties the field, as a search field's Esc
    // would (its ✕ does that).
    event.preventDefault()
    close()
  } else if (event.key === 'Enter' && !event.isComposing) {
    // Inside the filters' own form, Enter is this box's alone.
    event.preventDefault()
    submit()
  }
}
function submit() {
  close()
  const problem = error.value
  if (problem) {
    // To the place it cannot read.
    input.value?.focus()
    input.value?.setSelectionRange(problem.position, problem.position + 1)
    return
  }
  emit('submit', (input.value?.value ?? text.value).trim())
}
/**
 * Focus gone elsewhere in the page closes the list; the window losing it
 * (another app, another tab) leaves it for when it comes back.
 */
function blurred() {
  if (document.hasFocus()) close()
}
function clear() {
  close()
  put('', 0)
}

// The dropdown lines up with the text, under the whole box.
const { place } = useAnchoredPopover({
  element: () => list.value,
  anchor: () => {
    const box = bar.value?.getBoundingClientRect()
    const field = input.value?.getBoundingClientRect()
    if (!box || !field) return undefined
    const width = list.value?.offsetWidth ?? 0
    return {
      top: box.top,
      bottom: box.bottom,
      left: field.left,
      right: field.left + width,
    }
  },
  shown: () => options.value.length > 0,
})
watch(options, place, { flush: 'post' })
// The chosen option stays in sight.
watch(
  active,
  (i) => {
    if (i >= 0) list.value?.children[i]?.scrollIntoView?.({ block: 'nearest' })
  },
  { flush: 'post' },
)

const help = shallowRef(false)
/** An entry of `?`: in at the caret, spaced from what is before it. */
function insert(snippet: string, caret: number) {
  help.value = false
  const el = input.value
  if (!el) return
  const at = el.selectionStart ?? el.value.length
  const end = el.selectionEnd ?? at
  const before = el.value.slice(0, at)
  const space =
    snippet.startsWith(' ') || !before || OPEN_END.test(before) ? '' : ' '
  put(
    `${before}${space}${snippet}${el.value.slice(end)}`,
    at + space.length + caret,
  )
  complete()
}
</script>

<template>
  <div class="query" role="search">
    <div ref="bar" class="bar">
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
        ref="input"
        v-model="text"
        type="search"
        class="field"
        :placeholder="placeholder"
        :aria-label="label"
        role="combobox"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        enterkeyhint="search"
        aria-autocomplete="list"
        :aria-expanded="options.length > 0"
        :aria-controls="`${id}-options`"
        :aria-activedescendant="
          active >= 0 ? `${id}-option-${active}` : undefined
        "
        :aria-invalid="!!error"
        :aria-describedby="error || parsed ? `${id}-note` : undefined"
        @input="complete"
        @click="complete"
        @keyup.left="complete"
        @keyup.right="complete"
        @keydown="keydown"
        @blur="blurred"
      />
      <button
        v-if="text"
        type="button"
        class="icon"
        aria-label="清空搜索框"
        title="清空搜索框"
        @click="clear"
      >
        <svg
          viewBox="0 0 24 24"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="M7 7l10 10M17 7L7 17" />
        </svg>
      </button>
      <button
        ref="helpButton"
        type="button"
        class="icon"
        aria-label="查询语法"
        title="查询语法"
        :aria-expanded="help"
        @click="help = !help"
      >
        <svg
          viewBox="0 0 24 24"
          width="20"
          height="20"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.6" />
          <circle cx="12" cy="17" r="0.6" fill="currentColor" stroke="none" />
        </svg>
      </button>
    </div>
    <ul
      v-show="options.length"
      :id="`${id}-options`"
      ref="list"
      class="query-card options"
      popover="manual"
      role="listbox"
      aria-label="补全"
    >
      <li
        v-for="(option, i) in options"
        :id="`${id}-option-${i}`"
        :key="option.insert"
        role="option"
        :aria-selected="i === active"
        :class="{ active: i === active }"
        @pointerdown.prevent="accept(option)"
        @pointermove="active = i"
      >
        <QueryTerm class="option-term" :text="option.term" /><span
          v-if="option.detail"
          class="option-detail"
          >{{ option.detail }}</span
        >
      </li>
    </ul>
    <p v-if="error" :id="`${id}-note`" class="note error" role="alert">
      {{ error.message }}
      <code class="where"
        >{{ marked.before }}<mark>{{ marked.at }}</mark
        >{{ marked.after }}</code
      >
    </p>
    <p v-else-if="parsed" :id="`${id}-note`" class="note">
      解析为 <QueryTerm :text="parsed" />
    </p>
    <QueryHelp
      v-if="help"
      :anchor="() => bar?.getBoundingClientRect()"
      :toggle="() => helpButton"
      @close="help = false"
      @insert="insert"
    />
  </div>
</template>

<style scoped>
.query {
  position: relative;
}
/* One box: the ring of focus is the whole of it, not the field inside. */
.bar {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 40px;
  padding-inline: 12px 4px;
  background: var(--fill);
  border-radius: var(--radius);
}
.bar:focus-within {
  outline: 2px solid var(--link);
  /* Inside the box, so no scroller it sits in (the sidebar's, a sticky
     header) can cut it: whole and even on every side, with its corners. */
  outline-offset: -2px;
}
.glass {
  display: block;
  flex: none;
  width: 18px;
  height: 18px;
  margin-right: 4px;
  color: var(--subtle);
}
.field {
  flex: 1;
  min-width: 0;
  min-height: 40px;
  border: 0;
  background: none;
  font-size: 16px;
  outline: none;
}
.field::placeholder {
  color: var(--subtle);
}
/* Its own ✕, sized and placed as the box's other buttons. */
.field::-webkit-search-cancel-button {
  display: none;
}
.field[aria-invalid='true'] {
  text-decoration: underline wavy var(--destructive);
  text-underline-offset: 4px;
}
.icon {
  display: grid;
  flex: none;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  color: var(--subtle);
}
.icon:hover,
.icon[aria-expanded='true'] {
  background: color-mix(in srgb, var(--text) 8%, transparent);
  color: var(--text);
}
.icon:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: -2px;
}
.options {
  min-width: 220px;
  max-width: min(360px, calc(100vw - 16px));
  max-height: min(50dvh, 320px);
  list-style: none;
}
.options li {
  display: flex;
  align-items: baseline;
  gap: 16px;
  padding: 7px 14px;
  cursor: pointer;
  white-space: nowrap;
}
.options li.active {
  background: color-mix(in srgb, var(--link) 12%, transparent);
}
.option-term {
  flex: none;
  font-size: 14px;
}
.option-detail {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--subtle);
  font-size: 13px;
  text-align: right;
  text-overflow: ellipsis;
}
.note {
  margin: 4px 2px 0;
  color: var(--subtle);
  font-size: 13px;
  overflow-wrap: anywhere;
}
.error {
  color: var(--destructive);
}
.where {
  display: block;
  margin-top: 2px;
  color: var(--text);
  font-family: var(--mono, ui-monospace, 'SF Mono', Menlo, monospace);
  white-space: pre;
  overflow: hidden;
  text-overflow: ellipsis;
}
.where mark {
  background: var(--destructive);
  color: var(--card);
  border-radius: 2px;
}
</style>
