<script setup vapor lang="ts">
// The terms of the query language by group, each an example and what it
// does; the full reference is `docs/agent.md` section 6. Choosing one puts
// its key (or operator) into the box at the caret.
import { onMounted, onUnmounted, useTemplateRef } from 'vue'
import { useAnchoredPopover } from '../composables/useAnchoredPopover'
import QueryTerm from './QueryTerm.vue'
import type { Box } from '../action-menu'

const props = defineProps<{
  /** The box it opens under, and its own button, which toggles it. */
  anchor: () => Box | undefined
  toggle: () => HTMLElement | null | undefined
}>()
const emit = defineEmits<{
  close: []
  /** Text for the box, and where in it the caret goes. */
  insert: [text: string, caret: number]
}>()

interface Row {
  example: string
  text: string
  /** Put into the box; the caret after it unless `caret` says. */
  insert: string
  caret?: number
  /** More than fits on the line: the values it takes. */
  more?: string
}
const GROUPS: { title: string; rows: Row[] }[] = [
  {
    title: '组合',
    rows: [
      { example: '猫 狗', text: '两者都有', insert: ' ' },
      { example: '猫 OR 狗', text: '任一', insert: ' OR ' },
      { example: '-广告', text: '排除', insert: '-' },
      { example: '(猫 OR 狗) 图', text: '分组', insert: '()', caret: 1 },
      { example: '"两个 词"', text: '整个短语', insert: '""', caret: 1 },
    ],
  },
  {
    title: '人和关系',
    rows: [
      { example: 'from:@alice', text: '作者', insert: 'from:' },
      { example: 'mentions:@alice', text: '提到', insert: 'mentions:' },
      { example: 'reposted-by:@alice', text: '转发者', insert: 'reposted-by:' },
      { example: 'quotes:@alice', text: '引用其帖子', insert: 'quotes:' },
      { example: 'reposts:@alice', text: '转发其帖子', insert: 'reposts:' },
      {
        example: 'rel:following:@alice',
        text: '关注关系',
        insert: 'rel:',
        more: 'following 关注的、followers 粉丝、mutual 互关',
      },
    ],
  },
  {
    title: '内容',
    rows: [
      { example: '#猫', text: '话题', insert: '#' },
      { example: 'domain:youtube.com', text: '链接域名', insert: 'domain:' },
      {
        example: 'lang:ja',
        text: '语言',
        insert: 'lang:',
        more: 'ja、zh、ko、en、es、fr、de、pt…',
      },
      {
        example: 'has:image',
        text: '媒体或链接',
        insert: 'has:',
        more: 'image、video、media、link',
      },
      {
        example: 'is:quote',
        text: '帖子类型',
        insert: 'is:',
        more: 'original、quote、repost',
      },
    ],
  },
  {
    title: '时间',
    rows: [
      { example: 'since:2026-01-01', text: '发帖日期起', insert: 'since:' },
      { example: 'until:2026-02-01', text: '发帖日期前', insert: 'until:' },
      {
        example: 'within:30d',
        text: '最近发帖',
        insert: 'within:',
        more: '30d、12h',
      },
      {
        example: 'saved:7d',
        text: '收藏时间',
        insert: 'saved:',
        more: '7d、12h、2026-11-01；saved-since:、saved-until:',
      },
    ],
  },
  {
    title: '整理和状态',
    rows: [
      { example: 'tag:研究', text: '标签', insert: 'tag:' },
      { example: 'folder:猫', text: '收藏夹', insert: 'folder:' },
      {
        example: 'state:deleted',
        text: '原站状态',
        insert: 'state:',
        more: 'deleted、suspended',
      },
      {
        example: 'type:profile',
        text: '帖子或账号',
        insert: 'type:',
        more: 'post、profile',
      },
      { example: 'sensitive:yes', text: '敏感内容', insert: 'sensitive:' },
      { example: 'protected:yes', text: '私密账号', insert: 'protected:' },
      {
        example: 'platform:x',
        text: '平台',
        insert: 'platform:',
        more: 'x、instagram',
      },
    ],
  },
]

const panel = useTemplateRef<HTMLElement>('panel')
useAnchoredPopover({
  element: () => panel.value,
  anchor: props.anchor,
  shown: () => true,
  // Its own button toggles it; a press anywhere else closes it.
  outside: (event) => {
    if (!props.toggle()?.contains(event.target as Node)) emit('close')
  },
})
function escape(event: KeyboardEvent) {
  if (event.key !== 'Escape') return
  event.preventDefault()
  emit('close')
}
onMounted(() => document.addEventListener('keydown', escape))
onUnmounted(() => document.removeEventListener('keydown', escape))
function choose(row: Row) {
  emit('insert', row.insert, row.caret ?? row.insert.length)
}
</script>

<template>
  <div
    ref="panel"
    class="query-card query-help"
    popover="manual"
    role="dialog"
    aria-label="查询语法"
  >
    <section v-for="group in GROUPS" :key="group.title" class="group">
      <h3 class="group-title">{{ group.title }}</h3>
      <button
        v-for="row in group.rows"
        :key="row.example"
        type="button"
        class="row"
        :title="row.more ? `${row.text}：${row.more}` : row.text"
        @click="choose(row)"
      >
        <QueryTerm class="example" :text="row.example" /><span
          class="meaning"
          >{{ row.text }}</span
        >
      </button>
    </section>
  </div>
</template>

<style scoped>
.query-help {
  width: min(380px, calc(100vw - 16px));
  max-height: min(70dvh, 520px);
}
.group + .group {
  border-top: 1px solid var(--separator);
  margin-top: 4px;
  padding-top: 4px;
}
.group-title {
  margin: 6px 14px 2px;
  font-size: 12px;
  font-weight: 600;
  color: var(--subtle);
}
.row {
  display: flex;
  align-items: baseline;
  gap: 12px;
  width: 100%;
  padding: 6px 14px;
  text-align: left;
  white-space: nowrap;
}
.row:hover,
.row:focus-visible {
  background: color-mix(in srgb, var(--link) 10%, transparent);
  outline: none;
}
.example {
  flex: none;
  font-size: 14px;
}
.meaning {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--subtle);
  font-size: 13px;
  text-align: right;
  text-overflow: ellipsis;
}
</style>
