<script setup vapor lang="ts">
import { computed, shallowRef, useSlots } from 'vue'
import {
  groupCollections,
  listSort,
  listsProfiles,
  storageSize,
} from '../presentation'
import BatchRefresh from './BatchRefresh.vue'
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
  /** One account's own list: no author or platform to filter by. */
  withinProfile?: boolean
  /** A folder's list, whose filter may hold posts and accounts alike. */
  folder?: boolean
  enlargedMedia?: boolean
  /** Display name of the account this list belongs to, for its reposts. */
  repostedBy?: string
}>()
/** `actions`: more buttons for the toolbar, styled like 批量更新. */
const slots = useSlots()
const emit = defineEmits<{
  search: [query: string]
  open: [id: string]
  more: []
  retry: []
}>()
// An album shows posts' media; accounts have none to show.
const albums = computed(() => !listsProfiles(props.query))
const layout = computed(() =>
  albums.value && new URLSearchParams(props.query).get('layout') === 'album'
    ? 'album'
    : 'feed',
)
function changeLayout(value: 'feed' | 'album') {
  const q = new URLSearchParams(props.query)
  if (value === 'album') q.set('layout', value)
  else q.delete('layout')
  emit('search', q.toString())
}
// Selection is a mode of the feed: rows toggle instead of opening. The batch
// bar outlasts it, to link to the batch once started.
const selecting = shallowRef(false)
const batch = shallowRef(0)
const selected = shallowRef<string[]>([])
const listed = computed(() => props.items.map((a) => a.id))
function startSelecting() {
  selected.value = []
  selecting.value = true
  batch.value++
  if (layout.value === 'album') changeLayout('feed')
}
function closeBatch() {
  selecting.value = false
  batch.value = 0
}
function toggle(id: string) {
  selected.value = selected.value.includes(id)
    ? selected.value.filter((item) => item !== id)
    : [...selected.value, id]
}
const mediaTypes = computed(
  () => new URLSearchParams(props.query).get('media_type') || '',
)
const sort = computed(() => listSort(props.query))
const groups = computed(() =>
  groupCollections(props.items, new Date(), sort.value),
)
const filtered = computed(() => {
  const q = new URLSearchParams(props.query)
  return [
    'tag',
    'post_type',
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
const storage = computed(() =>
  props.usage ? `已用 ${storageSize(props.usage.used_bytes)}` : '',
)
</script>

<template>
  <p v-if="storage" class="storage">{{ storage }}</p>
  <CollectionFilters
    v-if="!hideFilters"
    :query="query"
    :within-profile="withinProfile"
    :folder="folder"
    @search="(value) => emit('search', value)"
  />
  <div
    v-if="(!selecting && items.length) || albums || slots.actions"
    class="layout-bar"
  >
    <slot name="actions" />
    <button
      v-if="!selecting && items.length"
      type="button"
      class="batch"
      @click="startSelecting"
    >
      批量更新
    </button>
    <LibraryLayoutToggle
      v-if="albums"
      :model-value="layout"
      @update:model-value="changeLayout"
    />
  </div>
  <ListSection v-if="error && !items.length">
    <p class="banner" role="alert">{{ error }}</p>
    <ListButton label="重试" @select="emit('retry')" />
  </ListSection>
  <CollectionAlbum
    v-if="layout === 'album'"
    :items="
      withinProfile
        ? items.filter(
            (item) =>
              !item.relation_types?.length ||
              item.relation_types.some(
                (type) => type === 'authored_by' || type === 'reposted',
              ),
          )
        : items
    "
    :media-types="mediaTypes"
    :show-sensitive="showSensitive"
    :loading="loading"
    :next="next"
    :error="error"
    @open="(value) => emit('open', value)"
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
        :enlarged-media="enlargedMedia"
        :sort="sort"
        :show-sensitive="showSensitive"
        :reposted-by="repostedBy"
        :selected="selecting ? selected.includes(a.id) : undefined"
        @open="(value) => emit('open', value)"
        @toggle="toggle"
      />
    </ListSection>
    <p v-if="empty && filtered" class="empty">没有匹配的收藏</p>
    <ListSection v-if="loading"><CollectionSkeleton /></ListSection>
  </template>
  <InfiniteLoader
    v-if="next"
    :loading="loading"
    :error="error"
    @more="emit('more')"
  />
  <BatchRefresh
    v-if="batch"
    :key="batch"
    :selected="selected"
    :listed="listed"
    @select="(value) => (selected = value)"
    @started="selecting = false"
    @close="closeBatch"
  />
</template>

<style scoped>
.layout-bar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin: 12px var(--gutter) 16px;
}
.batch,
.layout-bar :slotted(button) {
  min-height: 34px;
  padding: 0 12px;
  border-radius: 999px;
  font-size: 14px;
  color: var(--link);
  background: var(--fill);
}
.layout-bar :slotted(button:disabled) {
  color: var(--subtle);
}
.batch:active,
.layout-bar :slotted(button:active:not(:disabled)) {
  opacity: 0.7;
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
