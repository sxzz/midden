<script setup vapor lang="ts">
import {
  computed,
  onActivated,
  onDeactivated,
  onUnmounted,
  shallowRef,
  useId,
  useSlots,
  watch,
} from 'vue'
import {
  groupCollections,
  listSort,
  listsProfiles,
  searches,
  searchTerms,
  storageSize,
} from '../presentation'
import { accountKey } from '../relation-filter'
import { isProfileEntity } from '../relations'
import { shareSlug } from '../share'
import { suppressTabBar } from '../tabbar'
import BatchRefresh from './BatchRefresh.vue'
import CollectionAlbum from './CollectionAlbum.vue'
import CollectionFilters from './CollectionFilters.vue'
import CollectionRow from './CollectionRow.vue'
import DeleteSheet from './DeleteSheet.vue'
import CollectionSkeleton from './ui/CollectionSkeleton.vue'
import InfiniteLoader from './ui/InfiniteLoader.vue'
import LibraryLayoutToggle from './ui/LibraryLayoutToggle.vue'
import ListButton from './ui/ListButton.vue'
import ListSection from './ui/ListSection.vue'
import type { Collection, TagChange, Usage } from '../api'
const props = defineProps<{
  items: Collection[]
  showSensitive?: boolean
  query: string
  loading: boolean
  error: string
  next: string
  /** How many the list holds over all its pages, once counted. */
  total?: number
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
/** `actions`: more buttons for the toolbar, styled like 多选. */
const slots = useSlots()
const emit = defineEmits<{
  search: [query: string]
  more: []
  retry: []
  tagsChanged: [change: TagChange]
  /** Deleted from the selection; `withPosts` when accounts' posts went too. */
  deleted: [ids: string[], withPosts: boolean]
  mediaRemoved: []
}>()
// A public link has no selection; its filters leave out the owner's tags.
const shared = computed(() => !!shareSlug.value)
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
/** The selected accounts' keys, for comparing their relations. */
const selectedProfiles = computed(() => {
  const chosen = new Set(selected.value)
  return props.items.flatMap((a) => {
    const root = a.graph?.entities.find((e) => e.key === a.graph?.root)
    return chosen.has(a.id) && root && isProfileEntity(root)
      ? [accountKey(root)]
      : []
  })
})
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
// The 多选 bar takes the bottom bar's place while it shows, on this page.
const barKey = `selection:${useId()}`
watch(batch, (shown) => suppressTabBar(barKey, !!shown))
onActivated(() => suppressTabBar(barKey, !!batch.value))
onDeactivated(() => suppressTabBar(barKey, false))
onUnmounted(() => suppressTabBar(barKey, false))
const deleting = shallowRef(false)
function deleted(withPosts: boolean) {
  const ids = selected.value
  deleting.value = false
  closeBatch()
  emit('deleted', ids, withPosts)
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
const highlight = computed(() => searchTerms(props.query))
const groups = computed(() =>
  groupCollections(
    props.items,
    new Date(),
    searches(props.query) ? 'relevance' : sort.value,
  ),
)
const filtered = computed(() => {
  const q = new URLSearchParams(props.query)
  return [
    'tag',
    'not_tag',
    'rel_of',
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
// Accounts are counted as accounts; anything else a list holds, as items.
const totalText = computed(() =>
  props.total === undefined
    ? ''
    : `${props.total.toLocaleString('zh-CN')} ${listsProfiles(props.query) ? '个账号' : '条'}`,
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
    @tags-changed="(change) => emit('tagsChanged', change)"
  />
  <div
    v-if="totalText || (!selecting && items.length) || albums || slots.actions"
    class="layout-bar"
  >
    <span v-if="totalText" class="total">{{ totalText }}</span>
    <slot name="actions" />
    <button
      v-if="!selecting && items.length && !shared"
      type="button"
      class="batch"
      @click="startSelecting"
    >
      多选
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
        :highlight="highlight"
        :selected="selecting ? selected.includes(a.id) : undefined"
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
    :profiles="selectedProfiles"
    @select="(value) => (selected = value)"
    @started="selecting = false"
    @delete="deleting = true"
    @close="closeBatch"
    @media-removed="emit('mediaRemoved')"
  />
  <DeleteSheet
    v-if="batch"
    :open="deleting"
    :ids="selected"
    :title="`删除 ${selected.length} 项收藏？`"
    @deleted="deleted"
    @cancel="deleting = false"
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
/* The count leads; the buttons keep to the trailing edge. */
.total {
  margin-right: auto;
  font-size: 13px;
  color: var(--subtle);
  font-variant-numeric: tabular-nums;
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
