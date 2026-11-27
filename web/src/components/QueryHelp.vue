<script setup vapor lang="ts">
// The terms of the query language, each with an example; the full reference
// is `docs/agent.md` section 6.
import { onMounted, onUnmounted, useTemplateRef } from 'vue'
const emit = defineEmits<{ close: [] }>()
const panel = useTemplateRef<HTMLElement>('panel')
const ROWS: [string, string][] = [
  ['猫 狗', '同时包含'],
  ['猫 OR 狗', '任一'],
  ['-狗', '排除'],
  ['(猫 OR 狗) -广告', '分组'],
  ['"两个 词"', '短语'],
  ['#话题', '话题'],
  ['from:@alice', '作者'],
  ['mentions:@alice', '提到'],
  ['reposted-by:@alice', '转发者'],
  ['quotes:@alice', '引用其帖子'],
  ['rel:following:@alice', '关注的账号（followers、mutual）'],
  ['tag:标签', '标签'],
  ['folder:收藏夹', '收藏夹'],
  ['is:original', 'original、quote、repost'],
  ['has:image', 'image、video、media、link'],
  ['domain:youtube.com', '链接域名'],
  ['lang:ja', '语言'],
  ['platform:x', '平台'],
  ['type:profile', 'post、profile'],
  ['since:2026-01-01', '发帖日期起（until: 之前）'],
  ['within:30d', '最近 30 天发帖'],
  ['saved:7d', '最近 7 天收藏（saved-since:、saved-until:）'],
  ['state:deleted', '原站状态'],
  ['sensitive:yes', '敏感内容'],
  ['protected:yes', '私密账号'],
]
function outside(event: PointerEvent) {
  const el = panel.value
  if (el && !el.parentElement?.contains(event.target as Node)) emit('close')
}
function escape(event: KeyboardEvent) {
  if (event.key === 'Escape') emit('close')
}
onMounted(() => {
  document.addEventListener('pointerdown', outside)
  document.addEventListener('keydown', escape)
})
onUnmounted(() => {
  document.removeEventListener('pointerdown', outside)
  document.removeEventListener('keydown', escape)
})
</script>

<template>
  <div ref="panel" class="query-help" role="dialog" aria-label="查询语法">
    <table>
      <tbody>
        <tr v-for="[term, meaning] in ROWS" :key="term">
          <td>
            <code>{{ term }}</code>
          </td>
          <td>{{ meaning }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.query-help {
  position: absolute;
  z-index: 21;
  top: 44px;
  right: 0;
  width: min(360px, 100%);
  max-height: min(60dvh, 480px);
  overflow: auto;
  padding: 8px 12px;
  background: var(--page);
  border-radius: var(--radius);
  box-shadow: 0 4px 16px rgb(0 0 0 / 18%);
  font-size: 13px;
}
table {
  width: 100%;
  border-collapse: collapse;
}
td {
  padding: 4px 0;
  vertical-align: top;
}
td:first-child {
  padding-right: 12px;
  white-space: nowrap;
}
code {
  font-family: var(--mono, ui-monospace, monospace);
}
td:last-child {
  color: var(--subtle);
}
</style>
