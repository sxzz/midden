<script setup vapor lang="ts">
import { computed, reactive, shallowRef } from 'vue'
const props = defineProps<{ query: string }>()
const emit = defineEmits<{ search: [query: string] }>()
const initial = new URLSearchParams(props.query)
const form = reactive({
  order: initial.get('order') || 'desc',
  sort: initial.get('sort') || 'captured',
  q: initial.get('q') || '',
  entity: initial.get('entity_type') || 'x.post',
  media: (initial.get('media_type') || '').split(',').filter(Boolean),
  visibility: initial.get('visibility') || '',
  from: initial.get('from_date') || '',
  to: initial.get('to_date') || '',
})
const mediaNames: Record<string, string> = {
  image: '图片',
  video: '视频',
  text: '纯文字',
}
const visibilityNames: Record<string, string> = {
  public: '公开内容',
  private: '受限内容',
}
const open = shallowRef(
  !!(form.media.length || form.visibility || form.from || form.to),
)
const active = computed(() =>
  [
    form.entity === 'x.profile' ? 'X 账号' : 'X 帖子',
    form.media.map((type) => mediaNames[type]).join('、'),
    visibilityNames[form.visibility],
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
function search() {
  const q = new URLSearchParams()
  for (const [k, v] of [
    ['q', form.q],
    ['entity_type', form.entity],
    ['sort', form.sort],
    ['order', form.order],
    ['media_type', form.media.join(',')],
    ['visibility', form.visibility],
    ['from_date', form.from],
    ['to_date', form.to],
  ])
    if (v) q.set(k, v)
  emit('search', q.toString())
}
function changeSort(event: Event) {
  form.sort = (event.target as HTMLSelectElement).value
  search()
}
function changeOrder(event: Event) {
  form.order = (event.target as HTMLSelectElement).value
  search()
}
function clear() {
  Object.assign(form, {
    order: 'desc',
    sort: 'captured',
    q: '',
    entity: 'x.post',
    media: [],
    visibility: '',
    from: '',
    to: '',
  })
  emit('search', '')
}
</script>

<template>
  <form class="filters" @submit.prevent="search">
    <div class="bar">
      <span class="glass" aria-hidden="true">⌕</span
      ><input
        v-model="form.q"
        type="search"
        class="field"
        placeholder="搜索收藏"
        aria-label="搜索正文或作者"
        maxlength="500"
      /><button type="submit" class="submit">搜索</button>
    </div>
    <div class="toggles">
      <button
        type="button"
        class="toggle"
        :aria-expanded="open"
        @click="open = !open"
      >
        筛选<span v-if="active" class="separator" aria-hidden="true">·</span
        ><span v-if="active" class="active">{{ active }}</span
        ><span class="caret" :class="{ open }" aria-hidden="true">›</span>
      </button>
      <button v-if="query" type="button" class="toggle reset" @click="clear">
        清除
      </button>
    </div>
    <div class="sort">
      <span>排序</span>
      <select :value="form.sort" aria-label="排序" @change="changeSort">
        <option value="captured">采集时间</option>
        <option value="published">发帖时间</option>
        <option value="storage">存储空间</option>
      </select>
      <select :value="form.order" aria-label="排序方向" @change="changeOrder">
        <option value="desc">
          {{ form.sort === 'storage' ? '从大到小' : '从新到旧' }}
        </option>
        <option value="asc">
          {{ form.sort === 'storage' ? '从小到大' : '从旧到新' }}
        </option>
      </select>
    </div>
    <div v-show="open" class="panel">
      <label class="option"
        >类型<select v-model="form.entity" aria-label="类型">
          <option value="x.post">X 帖子</option>
          <option value="x.profile">X 账号</option>
        </select></label
      >
      <fieldset class="media-options">
        <legend>媒体类型</legend>
        <label v-for="(name, value) in mediaNames" :key="value">
          <input v-model="form.media" type="checkbox" :value="value" />{{
            name
          }}
        </label>
        <p class="hint">不选表示全部；多选时匹配任意一种。</p>
      </fieldset>
      <label class="option"
        >来源内容权限<select v-model="form.visibility">
          <option value="">全部</option>
          <option value="public">公开内容</option>
          <option value="private">受限内容</option>
        </select></label
      >
      <p class="hint">
        指采集时原内容的访问权限；受限内容按你的账号隔离保存，并非收藏的分享设置。
      </p>
      <fieldset class="dates">
        <legend>收藏日期</legend>
        <label class="option"
          >从<input v-model="form.from" type="date" aria-label="收藏开始日期"
        /></label>
        <label class="option"
          >至<input
            v-model="form.to"
            type="date"
            :min="form.from"
            aria-label="收藏结束日期"
        /></label>
        <p class="hint">
          按加入收藏的日期筛选，包含开始和结束当天；留空表示不限。
        </p>
      </fieldset>
      <div class="panel-actions">
        <button type="submit" class="apply">应用筛选</button>
      </div>
    </div>
  </form>
</template>

<style scoped>
.sort {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 40px;
  padding: 0 4px;
  font-size: 14px;
  color: var(--subtle);
}
.sort select {
  min-height: 40px;
  border: 0;
  background: none;
  color: var(--link);
  font: inherit;
}
.filters {
  padding: 10px var(--gutter) 6px;
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
  font-size: 20px;
  line-height: 1;
  color: var(--subtle);
}
.field {
  flex: 1;
  min-width: 0;
  min-height: 44px;
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
  min-height: 44px;
  padding-left: 4px;
  font-size: 15px;
  color: var(--link);
}
.toggles {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.toggle {
  display: flex;
  align-items: center;
  min-height: 40px;
  padding: 0 4px;
  font-size: 14px;
  color: var(--link);
}
.reset {
  color: var(--subtle);
}
.separator {
  padding-inline: 6px;
}
.toggle {
  min-width: 0;
}
.hint {
  margin: 0;
  padding: 4px var(--inset) 12px;
  color: var(--subtle);
  font-size: 12px;
  line-height: 1.5;
}
.media-options,
.dates {
  margin: 0;
  padding: 8px 0;
  border: 0;
  min-width: 0;
}
legend {
  padding: 8px var(--inset) 0;
  font-size: 15px;
}
.media-options label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 44px;
  margin-left: var(--inset);
}
.media-options input {
  accent-color: var(--link);
}
.active {
  color: var(--subtle);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.caret {
  display: inline-block;
  margin-left: 4px;
  font-size: 17px;
  line-height: 1;
  transform: rotate(90deg);
  transition: transform 0.15s ease;
}
.caret.open {
  transform: rotate(-90deg);
}
.panel {
  background: var(--card);
  border-radius: var(--radius);
  margin-top: 4px;
  overflow: hidden;
}
.option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 48px;
  padding: 6px var(--inset);
  font-size: 16px;
}
.option {
  position: relative;
}
.option + .option::before,
.panel-actions::before {
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
  max-width: 60%;
  border: 0;
  background: none;
  color: var(--link);
  font-size: 16px;
  text-align: right;
}
.panel-actions {
  position: relative;
}
.apply {
  display: block;
  padding: 11px var(--inset);
  text-align: left;
  width: 100%;
  min-height: 48px;
  color: var(--link);
  font-size: 16px;
}
</style>
