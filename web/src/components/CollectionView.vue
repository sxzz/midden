<script setup vapor lang="ts">
import { computed } from 'vue'
import { groupCollections } from '../presentation'
import CollectionAlbum from './CollectionAlbum.vue'
import CollectionFilters from './CollectionFilters.vue'
import CollectionRow from './CollectionRow.vue'
import CollectionSkeleton from './ui/CollectionSkeleton.vue'
import InfiniteLoader from './ui/InfiniteLoader.vue'
import LibraryLayoutToggle from './ui/LibraryLayoutToggle.vue'
import ListButton from './ui/ListButton.vue'
import ListSection from './ui/ListSection.vue'
import type { Collection, Usage } from '../api'
const props = defineProps<{
  items: Collection[]
  showSensitive?: boolean
  query: string
  loading: boolean
  error: string
  next: string
  usage?: Usage
  hideFilters?: boolean
  /** Display name of the account this list belongs to, for its reposts. */
  repostedBy?: string
}>()
const emit = defineEmits<{
  search: [query: string]
  open: [id: string]
  more: []
  retry: []
}>()
const layout = computed(() =>
  new URLSearchParams(props.query).get('layout') === 'album' ? 'album' : 'feed',
)
function changeLayout(value: 'feed' | 'album') {
  const q = new URLSearchParams(props.query)
  if (value === 'album') q.set('layout', value)
  else q.delete('layout')
  emit('search', q.toString())
}
const mediaTypes = computed(
  () => new URLSearchParams(props.query).get('media_type') || '',
)
const sort = computed(
  () => new URLSearchParams(props.query).get('sort') || 'captured',
)
const groups = computed(() =>
  groupCollections(props.items, new Date(), sort.value),
)
const filtered = computed(() => {
  const q = new URLSearchParams(props.query)
  return [
    'tag',
    'q',
    'author',
    'media_type',
    'visibility',
    'sensitive',
    'from_date',
    'to_date',
  ].some((key) => !!q.get(key))
})
const empty = computed(
  () => !props.loading && !props.error && !props.items.length,
)
const size = (n: number) =>
  n >= 1073741824
    ? `${(n / 1073741824).toFixed(1)} GB`
    : `${(n / 1048576).toFixed(0)} MB`
const storage = computed(() =>
  props.usage
    ? `已用 ${size(props.usage.used_bytes)}，${
        props.usage.unlimited ? '不限额' : `共 ${size(props.usage.limit_bytes)}`
      }${
        props.usage.reserved_bytes
          ? `，${size(props.usage.reserved_bytes)} 正在保存`
          : ''
      }`
    : '',
)
</script>

<template>
  <p v-if="storage" class="storage">{{ storage }}</p>
  <CollectionFilters
    v-if="!hideFilters"
    :query="query"
    @search="$emit('search', $event)"
  />
  <div class="layout-bar">
    <LibraryLayoutToggle
      :model-value="layout"
      @update:model-value="changeLayout"
    />
  </div>
  <ListSection v-if="error && !items.length">
    <p class="banner" role="alert">{{ error }}</p>
    <ListButton label="重试" @select="$emit('retry')" />
  </ListSection>
  <CollectionAlbum
    v-if="layout === 'album'"
    :items="items"
    :media-types="mediaTypes"
    :show-sensitive="showSensitive"
    :loading="loading"
    :next="next"
    :error="error"
    @open="$emit('open', $event)"
  />
  <template v-else>
    <ListSection
      v-for="group in groups"
      :key="group.label"
      :title="group.label"
    >
      <CollectionRow
        v-for="a in group.items"
        :key="a.id"
        :collection="a"
        :sort="sort"
        :show-sensitive="showSensitive"
        :reposted-by="repostedBy"
        @open="$emit('open', $event)"
      />
    </ListSection>
    <p v-if="empty" class="empty">
      {{ filtered ? '没有匹配的收藏' : '暂无收藏' }}
    </p>
    <ListSection v-if="loading"><CollectionSkeleton /></ListSection>
  </template>
  <InfiniteLoader
    v-if="next"
    :loading="loading"
    :error="error"
    @more="$emit('more')"
  />
</template>

<style scoped>
.layout-bar {
  display: flex;
  justify-content: flex-end;
  margin: 0 var(--gutter) 16px;
}
.banner {
  margin: 0;
  padding: 14px var(--inset);
  font-size: 15px;
  line-height: 1.5;
}
.empty {
  margin: 0;
  padding: 48px 32px;
  text-align: center;
  font-size: 15px;
  line-height: 1.7;
  color: var(--subtle);
}
.storage {
  margin: 0 0 16px;
  padding: 0 calc(var(--gutter) + 4px);
  font-size: 13px;
  line-height: 1.5;
  color: var(--subtle);
}
</style>
