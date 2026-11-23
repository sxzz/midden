<script setup vapor lang="ts">
import { computed, reactive, ref } from 'vue'
import ChevronIcon from './ui/ChevronIcon.vue'
import type { CaptureOptions } from '../api'
const model = defineModel<CaptureOptions>({ required: true })
const open = ref(false)
const form = reactive({
  mediaOnly: false,
  includeShared: true,
  captureReferences: true,
  maxPosts: '',
  days: '',
})
const ranges = [
  { value: '', label: '全部' },
  { value: '1', label: '最近 1 天' },
  { value: '7', label: '最近 7 天' },
  { value: '30', label: '最近 30 天' },
  { value: '90', label: '最近 90 天' },
  { value: '365', label: '最近一年' },
]
const options = computed<CaptureOptions>(() => {
  const since = new Date()
  if (form.days) since.setDate(since.getDate() - Number(form.days))
  return {
    media_only: form.mediaOnly,
    omit_shared: !form.includeShared,
    skip_references: !form.captureReferences,
    max_posts: form.maxPosts ? Number(form.maxPosts) : undefined,
    since: form.days ? since.toISOString() : undefined,
  }
})
// Shown while collapsed so a non-default choice is never hidden.
const summary = computed(() => {
  const parts: string[] = []
  if (form.mediaOnly) parts.push('仅媒体')
  if (!form.includeShared) parts.push('不含转帖')
  if (!form.captureReferences) parts.push('原帖外链')
  if (form.maxPosts) parts.push(`最多 ${form.maxPosts} 条`)
  if (form.days) parts.push(ranges.find((r) => r.value === form.days)!.label)
  return parts.join(' · ') || '全部采集'
})
function update() {
  model.value = options.value
}
</script>

<template>
  <details
    class="capture-options"
    @toggle="open = ($event.target as HTMLDetailsElement).open"
    @change="update"
  >
    <summary>
      <span class="title">采集选项</span>
      <span class="summary">{{ summary }}</span>
      <ChevronIcon :open="open" />
    </summary>
    <label class="row"
      ><span>仅采集含图片或视频的帖子</span
      ><input
        v-model="form.mediaOnly"
        class="switch"
        type="checkbox"
        role="switch"
    /></label>
    <label class="row"
      ><span>包含引用转帖和纯转发</span
      ><input
        v-model="form.includeShared"
        class="switch"
        type="checkbox"
        role="switch"
    /></label>
    <label class="row"
      ><span>采集引用、转发的原帖</span
      ><input
        v-model="form.captureReferences"
        class="switch"
        type="checkbox"
        role="switch"
    /></label>
    <label class="row"
      ><span>最多采集帖子</span
      ><input
        v-model="form.maxPosts"
        class="value"
        type="number"
        inputmode="numeric"
        min="1"
        max="100000"
        step="1"
        placeholder="不限"
        aria-label="最多采集帖子"
    /></label>
    <label class="row"
      ><span>发帖日期</span
      ><span class="select"
        ><select v-model="form.days" class="value" aria-label="采集发帖日期">
          <option v-for="r in ranges" :key="r.value" :value="r.value">
            {{ r.label }}
          </option></select
        ><ChevronIcon class="select-chevron" /></span
    ></label>
    <p class="note">
      以上条件用于账号主页的帖子采集；引用原帖选项也用于单条帖子{{
        form.captureReferences ? '' : '，未保存的原帖保留外链'
      }}。
    </p>
  </details>
</template>

<style scoped>
.capture-options {
  box-shadow: inset 0 1px 0 var(--separator);
}
summary {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 48px;
  padding: 0 calc(var(--inset) - 4px) 0 var(--inset);
  cursor: pointer;
  list-style: none;
  -webkit-user-select: none;
  user-select: none;
}
summary::-webkit-details-marker {
  display: none;
}
summary:active {
  background: var(--fill);
}
summary:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: -2px;
}
.title {
  flex: none;
  font-size: 16px;
}
.summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 15px;
  color: var(--subtle);
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 48px;
  margin-left: var(--inset);
  padding: 6px var(--inset) 6px 0;
  font-size: 15px;
  box-shadow: inset 0 1px 0 var(--separator);
}
.switch {
  appearance: none;
  -webkit-appearance: none;
  position: relative;
  flex: none;
  width: 46px;
  height: 28px;
  margin: 0;
  border-radius: 14px;
  background: var(--fill);
  cursor: pointer;
  transition: background 160ms ease;
}
.switch::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
  transition: transform 160ms ease;
}
.switch:checked {
  background: var(--link);
}
.switch:checked::after {
  transform: translateX(18px);
}
.switch:focus-visible,
.value:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: 2px;
}
.value {
  min-height: 32px;
  border: 0;
  border-radius: 8px;
  background: var(--fill);
  font-size: 15px;
  color: inherit;
}
input.value {
  width: 96px;
  padding: 4px 10px;
  text-align: right;
}
input.value::placeholder {
  color: var(--subtle);
}
.select {
  position: relative;
  flex: none;
}
select.value {
  appearance: none;
  -webkit-appearance: none;
  padding: 4px 30px 4px 10px;
}
.select-chevron {
  position: absolute;
  right: 4px;
  top: calc(50% - 12px);
  pointer-events: none;
}
.note {
  margin: 0;
  padding: 8px var(--inset) 14px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--subtle);
  box-shadow: inset 0 1px 0 var(--separator);
}
@media (prefers-reduced-motion: reduce) {
  .switch,
  .switch::after {
    transition: none;
  }
}
</style>
