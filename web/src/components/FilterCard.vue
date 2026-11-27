<script setup vapor lang="ts">
import { computed, inject, shallowRef } from 'vue'
import { FILTER_CARD } from '../filter-card'
import RelationFilter from './RelationFilter.vue'
import ChevronIcon from './ui/ChevronIcon.vue'
import MultiSelect from './ui/MultiSelect.vue'
import SegmentedControl from './ui/SegmentedControl.vue'
import TagFilterChips from './ui/TagFilterChips.vue'
/**
 * The list's filters as a card in the sidebar from 1000px (筛选): labelled
 * groups of compact controls, the common ones open, the rarer ones under
 * 更多条件; every change applies at once, as the column's panel does, and
 * 重置 clears them all. The form is CollectionFilters' (see filter-card.ts),
 * so the query box in the column says the same.
 */
const {
  form,
  posts,
  shared,
  withinProfile,
  searching,
  orderNames,
  tags,
  tagError,
  loadTags,
  managing,
  toggleManaging,
  editTag,
  authors,
  mediaOptions,
  range,
  rangeOptions,
  sourceStateNames,
  relationSummary,
  clearable,
  clear,
  total,
  openHelp,
} = inject(FILTER_CARD)!
const all = (options: Record<string, string>) => [
  { value: '', label: '全部' },
  ...Object.entries(options).map(([value, label]) => ({ value, label })),
]
const postTypes = all({ post: '贴文', quote: '引用', repost: '转发' })
const visibilities = all({ public: '公开', private: '私密' })
const sensitivities = all({ contains: '包含', not_contains: '不含' })
const platforms = all({ x: 'X', instagram: 'Instagram' })
const sourceStates = computed(() => all(sourceStateNames.value))
/** Media types are several at once: each a pill that toggles. */
function toggleMedia(value: string) {
  form.media = form.media.includes(value)
    ? form.media.filter((type) => type !== value)
    : [...form.media, value]
}
/** 更多条件 opens by itself when one of its filters is set. */
const moreSet = () =>
  !!(
    form.platform ||
    form.visibility ||
    form.sensitive ||
    form.sourceState ||
    form.relOf.length
  )
const more = shallowRef(moreSet())
const setSummary = (text: string) => (relationSummary.value = text)
const setRange = (event: Event) =>
  (range.value = (event.target as HTMLSelectElement).value)
</script>

<template>
  <section class="aside-box filter-card" aria-labelledby="filter-card-title">
    <header class="card-head">
      <h2 id="filter-card-title">筛选</h2>
      <button type="button" class="reset" :disabled="!clearable" @click="clear">
        重置
      </button>
    </header>

    <div class="group">
      <span class="group-label">排序</span>
      <div class="selects">
        <span class="select"
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
          ><ChevronIcon class="select-chevron"
        /></span>
      </div>
    </div>

    <template v-if="posts">
      <div class="group">
        <span class="group-label" aria-hidden="true">帖子类型</span>
        <SegmentedControl
          v-model="form.postType"
          label="帖子类型"
          :options="postTypes"
        />
      </div>
      <div class="group">
        <span class="group-label" aria-hidden="true">媒体</span>
        <div class="pills" role="group" aria-label="媒体类型">
          <button
            v-for="option in mediaOptions"
            :key="option.value"
            type="button"
            class="pill"
            :aria-pressed="form.media.includes(option.value)"
            @click="toggleMedia(option.value)"
          >
            {{ option.label }}
          </button>
        </div>
      </div>
      <div v-if="!withinProfile" class="row">
        <MultiSelect
          v-model="form.authors"
          label="作者"
          remote
          :options="authors.options.value"
          :names="authors.names.value"
          :loading="authors.loading.value"
          :more="authors.more.value"
          @open="authors.open"
          @search="authors.search"
          @more="authors.load(true)"
        />
        <p v-if="authors.error.value" class="hint bad" role="alert">
          {{ authors.error.value }}
          <button type="button" class="retry" @click="authors.load()">
            重试
          </button>
        </p>
      </div>
    </template>

    <div v-if="!shared && (tags.length || tagError)" class="group">
      <span class="group-label"
        >标签<button
          v-if="tags.length"
          type="button"
          class="manage"
          :aria-pressed="managing"
          @click="toggleManaging"
        >
          {{ managing ? '完成' : '编辑' }}
        </button></span
      >
      <div v-if="managing" class="pills" role="group" aria-label="编辑标签">
        <button
          v-for="tag in tags"
          :key="tag.id"
          type="button"
          class="pill"
          :aria-label="`编辑标签「${tag.name}」`"
          @click="editTag(tag)"
        >
          {{ tag.name }}
        </button>
      </div>
      <template v-else-if="tags.length">
        <TagFilterChips
          v-model:include="form.tag"
          v-model:exclude="form.notTag"
          label="标签筛选"
          :tags="tags"
        />
        <SegmentedControl
          v-if="form.tag.length > 1"
          v-model="form.tagMode"
          class="tag-mode"
          label="标签匹配方式"
          :options="[
            { value: '', label: '任一' },
            { value: 'all', label: '全部' },
          ]"
        />
      </template>
      <p v-if="tagError" class="hint bad" role="alert">
        {{ tagError }}
        <button type="button" class="retry" @click="loadTags">重试</button>
      </p>
    </div>

    <div v-if="!shared" class="group">
      <span class="group-label">收藏日期</span>
      <span class="select wide"
        ><select :value="range" aria-label="收藏日期" @change="setRange">
          <option value="">全部</option>
          <option
            v-for="option in rangeOptions"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </option>
          <option value="custom">自定义</option></select
        ><ChevronIcon class="select-chevron"
      /></span>
      <div
        v-if="range === 'custom'"
        class="dates"
        role="group"
        aria-label="自定义收藏日期"
      >
        <label
          >从<input v-model="form.from" type="date" aria-label="收藏开始日期"
        /></label>
        <label
          >到<input
            v-model="form.to"
            type="date"
            :min="form.from"
            aria-label="收藏结束日期"
        /></label>
      </div>
    </div>

    <details
      class="more"
      :open="more"
      @toggle="more = ($event.target as HTMLDetailsElement).open"
    >
      <summary>
        更多条件<ChevronIcon class="more-chevron" :open="more" />
      </summary>
      <div v-if="!withinProfile" class="group">
        <span class="group-label" aria-hidden="true">平台</span>
        <SegmentedControl
          v-model="form.platform"
          label="平台"
          :options="platforms"
        />
      </div>
      <div class="group">
        <span class="group-label" aria-hidden="true">{{
          posts ? '作者可见性' : '可见性'
        }}</span>
        <SegmentedControl
          v-model="form.visibility"
          :label="posts ? '作者可见性' : '可见性'"
          :options="visibilities"
        />
      </div>
      <div v-if="posts" class="group">
        <span class="group-label" aria-hidden="true">敏感内容</span>
        <SegmentedControl
          v-model="form.sensitive"
          label="敏感内容"
          :options="sensitivities"
        />
      </div>
      <div class="group">
        <span class="group-label">原站状态</span>
        <span class="select wide"
          ><select v-model="form.sourceState" aria-label="原站状态">
            <option
              v-for="option in sourceStates"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option></select
          ><ChevronIcon class="select-chevron"
        /></span>
      </div>
      <div v-if="!shared" class="row">
        <RelationFilter
          v-model:rel-of="form.relOf"
          v-model:rel="form.rel"
          v-model:rel-min="form.relMin"
          @summary="setSummary"
        />
      </div>
    </details>

    <footer class="card-foot">
      <span class="total">{{ total }}</span>
      <button v-if="!shared" type="button" class="syntax" @click="openHelp">
        查询语法
      </button>
    </footer>
  </section>
</template>

<style scoped>
/* Compact: small labels, tight groups. Not a scroller of its own: the
   sidebar stays in the window and scrolls as one (SidebarFrame), so a
   wheel over the card always moves it and reaches its foot; a card that
   scrolled inside itself would hold the wheel even with nothing to
   scroll. Its heading stays at the top while the card passes. */
.filter-card {
  padding: 0;
  overflow: visible;
}
.card-head {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px 4px;
  border-radius: 16px 16px 0 0;
  background: var(--card);
}
.card-head h2 {
  margin: 0;
  font-size: 19px;
  font-weight: 800;
  line-height: 1.3;
}
.reset {
  min-height: 28px;
  padding: 0 10px;
  border-radius: 999px;
  color: var(--link);
  font-size: 14px;
}
.reset:hover:not(:disabled) {
  background: var(--fill);
}
.reset:disabled {
  color: var(--subtle);
  opacity: 1;
}
.group {
  display: grid;
  gap: 6px;
  padding: 8px 16px;
}
.group-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--subtle);
  font-size: 12px;
  font-weight: 600;
}
.hint {
  margin: 0;
  color: var(--subtle);
  font-size: 12px;
  line-height: 1.45;
}
.hint.bad {
  color: var(--destructive);
}
.retry,
.manage {
  color: var(--link);
  font-size: 12px;
  font-weight: 600;
}
.retry {
  margin-left: 6px;
}
.selects {
  display: flex;
  gap: 6px;
}
.select {
  position: relative;
  display: flex;
  flex: 1;
  min-width: 0;
}
.select select {
  width: 100%;
  min-height: 30px;
  padding: 0 26px 0 10px;
  border: 0;
  border-radius: 8px;
  background: var(--fill);
  color: var(--text);
  font-size: 13px;
  appearance: none;
}
.select-chevron {
  position: absolute;
  top: 50%;
  right: 8px;
  color: var(--subtle);
  transform: translateY(-50%);
  pointer-events: none;
}
.pills {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.pill {
  min-height: 28px;
  padding: 0 12px;
  border-radius: 999px;
  background: var(--fill);
  color: var(--text);
  font-size: 13px;
}
.pill[aria-pressed='true'] {
  background: color-mix(in srgb, var(--link) 16%, transparent);
  box-shadow: inset 0 0 0 1.5px var(--link);
  color: var(--link);
  font-weight: 600;
}
.tag-mode {
  max-width: 160px;
}
.dates {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
.dates label {
  display: grid;
  gap: 2px;
  color: var(--subtle);
  font-size: 12px;
}
.dates input {
  min-width: 0;
  min-height: 30px;
  padding: 0 6px;
  border: 0;
  border-radius: 8px;
  background: var(--fill);
  color: var(--text);
  font-size: 13px;
}
/* MultiSelect and 关系 are rows of their own, edge to edge. */
.row {
  --inset: 16px;
  font-size: 14px;
}
.row :deep(summary) {
  min-height: 36px;
  font-size: 13px;
}
/* Its name reads as the other groups' labels. */
.row :deep(summary > span:first-child) {
  color: var(--subtle);
  font-size: 12px;
  font-weight: 600;
}
.more {
  border-top: 1px solid var(--separator);
  margin-top: 4px;
}
.more > summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 40px;
  padding: 0 16px;
  color: var(--text);
  font-size: 14px;
  font-weight: 600;
  list-style: none;
  cursor: pointer;
}
.more > summary::-webkit-details-marker {
  display: none;
}
.more > summary:focus-visible {
  outline-offset: -2px;
}
.more-chevron {
  color: var(--subtle);
}
.card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 16px 12px;
  border-top: 1px solid var(--separator);
  color: var(--subtle);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.syntax {
  color: var(--link);
  font-size: 13px;
}
</style>
