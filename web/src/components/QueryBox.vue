<script setup vapor lang="ts">
// The owner's search box: a query of the query language (`query.ts`), read
// as it is typed. A query it cannot read shows why, and where; one it reads
// differently from how it is written shows how. Terms are completed from
// the keys, their fixed values, and what the library holds (handles, tags,
// folders, hashtags, domains). `?` lists the terms.
import { computed, onUnmounted, shallowRef, useId, useTemplateRef } from 'vue'
import { call, client } from '../api'
import {
  completing,
  KEYS,
  quoteValue,
  readQuery,
  type Completing,
} from '../query'
import QueryHelp from './QueryHelp.vue'
withDefaults(defineProps<{ placeholder?: string; label?: string }>(), {
  placeholder: '搜索收藏',
  label: '搜索或筛选',
})
const text = defineModel<string>({ required: true })
const emit = defineEmits<{ submit: [query: string] }>()
const AT = /^@/
const id = useId()
const input = useTemplateRef<HTMLInputElement>('input')
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

interface Option {
  insert: string
  label: string
  detail?: string
}
const options = shallowRef<Option[]>([])
const active = shallowRef(-1)
let target: Completing | undefined
const cache = new Map<string, Option[]>()
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
  const done = (insert: string) => `${c.lead}${insert}`
  if (c.source.kind === 'keys') {
    const prefix = c.prefix.toLowerCase()
    return show(
      KEYS.filter((k) => k.startsWith(prefix)).map((k) => ({
        insert: done(`${k}:`),
        label: `${k}:`,
      })),
    )
  }
  if (c.source.kind === 'values') {
    const prefix = c.prefix.toLowerCase()
    return show(
      c.source.values
        .filter((v) => v.startsWith(prefix) && v !== prefix)
        .map((v) => ({
          insert: done(v.endsWith(':') ? v : `${v} `),
          label: v,
        })),
    )
  }
  const { remote } = c.source
  // A handle is completed without its `@`; the rest as typed.
  const prefix = remote === 'handle' ? c.prefix.replace(AT, '') : c.prefix
  const key = `${remote}\n${prefix}`
  const quoted = c.lead.endsWith('"')
  const toOption = (item: {
    value: string
    label?: string
    count?: number
  }) => ({
    insert: done(
      quoted
        ? `${item.value.replaceAll('"', '""')}" `
        : `${remote === 'handle' || remote === 'hashtag' ? item.value : quoteValue(item.value)} `,
    ),
    label: remote === 'hashtag' ? `#${item.value}` : item.value,
    detail: [item.label, item.count === undefined ? '' : String(item.count)]
      .filter(Boolean)
      .join(' · '),
  })
  const known = cache.get(key)
  if (known) return show(known)
  // Until they come, offer nothing: the last values were for another prefix.
  close()
  const version = ++asked
  timer = setTimeout(async () => {
    try {
      const { items } = await call(
        client.query.suggest.$get({ query: { kind: remote, prefix } }),
      )
      const found = items.map(toOption)
      cache.set(key, found)
      if (version === asked && target === c) show(found)
    } catch {
      // Nothing to offer; the query still reads.
    }
  }, 120)
}
function show(found: Option[]) {
  options.value = found.slice(0, 8)
  active.value = found.length ? 0 : -1
}
function close() {
  options.value = []
  active.value = -1
}
function accept(option: Option) {
  const c = target
  const el = input.value
  if (!c || !el) return
  const value =
    el.value.slice(0, c.start) + option.insert + el.value.slice(c.end)
  const caret = c.start + option.insert.length
  // In the field at once, caret and all, so keys typed right after land
  // after it; the model follows.
  el.value = value
  el.setSelectionRange(caret, caret)
  text.value = value
  close()
  if (document.activeElement !== el) el.focus()
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
  } else if (event.key === 'Escape' && open) {
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
const help = shallowRef(false)
</script>

<template>
  <div class="query" role="search">
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
        @blur="close"
      /><button
        type="button"
        class="help"
        aria-label="查询语法"
        :aria-expanded="help"
        @click="help = !help"
      >
        ?</button
      ><button type="button" class="submit" @click="submit">搜索</button>
    </div>
    <ul
      v-show="options.length"
      :id="`${id}-options`"
      class="options"
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
      >
        <span class="option-label">{{ option.label }}</span><span
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
      解析为 <code>{{ parsed }}</code>
    </p>
    <QueryHelp v-if="help" @close="help = false" />
  </div>
</template>

<style scoped>
.query {
  position: relative;
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
.field[aria-invalid='true'] {
  text-decoration: underline wavy var(--danger, #d33);
  text-underline-offset: 4px;
}
.help {
  flex: none;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 1px solid var(--subtle);
  color: var(--subtle);
  font-size: 13px;
  line-height: 1;
}
.submit {
  flex-shrink: 0;
  min-height: 40px;
  padding-left: 4px;
  font-size: 15px;
  color: var(--link);
}
.options {
  position: absolute;
  z-index: 20;
  top: 44px;
  left: 0;
  right: 0;
  margin: 0;
  padding: 4px 0;
  list-style: none;
  background: var(--page);
  border-radius: var(--radius);
  box-shadow: 0 4px 16px rgb(0 0 0 / 18%);
}
.options li {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 8px 12px;
  cursor: pointer;
}
.options li.active {
  background: var(--fill);
}
.option-label {
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 14px;
}
.option-detail {
  min-width: 0;
  overflow: hidden;
  color: var(--subtle);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.note {
  margin: 4px 2px 0;
  color: var(--subtle);
  font-size: 13px;
  overflow-wrap: anywhere;
}
.note code {
  font-family: var(--mono, ui-monospace, monospace);
}
.error {
  color: var(--danger, #d33);
}
.where {
  display: block;
  margin-top: 2px;
  color: var(--text);
  white-space: pre;
  overflow: hidden;
  text-overflow: ellipsis;
}
.where mark {
  background: var(--danger, #d33);
  color: var(--page);
  border-radius: 2px;
}
</style>
