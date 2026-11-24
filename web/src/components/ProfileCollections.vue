<script setup vapor lang="ts">
import { computed, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useCollection } from '../composables/useCollection'
import { storageSize } from '../presentation'
import { collectionRoute } from '../share'
import CollectionView from './CollectionView.vue'
import ListButton from './ui/ListButton.vue'
import ListSection from './ui/ListSection.vue'
const props = defineProps<{
  id: string
  revisionId: string
  platform?: string
  /** Bumped when a refresh of this profile saved new or updated posts. */
  membersVersion?: number
  showSensitive?: boolean
  /** This profile's display name, shown on the posts it reposted. */
  repostedBy?: string
  /** The timeline goes on past the last page read: offer the next one. */
  older?: boolean
  olderBusy?: boolean
}>()
const emit = defineEmits<{
  /** Read the timeline's next page (抓取更早的帖子). */
  older: []
  /** Posts deleted from this list, as `CollectionView` reports them. */
  deleted: [ids: string[], withPosts: boolean]
}>()
const router = useRouter()
// Newest posts first is already the default order of a list of posts.
const filters = shallowRef('')
const query = computed(() => {
  const q = new URLSearchParams(filters.value)
  q.set('related_to', props.id)
  return q.toString()
})
// The profile's own platform is a given of the request, not a filter the
// reader chose: kept out of `query`, the filters neither show nor clear it.
const request = computed(() => {
  const q = new URLSearchParams(query.value)
  q.set('entity_type', `${props.platform || 'x'}.post`)
  return q.toString()
})
const {
  items,
  next,
  loading,
  refreshing,
  error,
  total,
  totalStorageBytes,
  load,
  refresh,
  more,
} = useCollection()
const requestQuery = computed(() => {
  const q = new URLSearchParams(request.value)
  q.delete('layout')
  return q.toString()
})
watch(
  () => requestQuery.value,
  () => load(request.value),
  { immediate: true },
)
// A refreshed profile keeps its list on screen while the new posts load in.
watch(
  () => [props.revisionId, props.membersVersion],
  () => {
    if (!loading.value) void refresh()
  },
)
function search(value: string) {
  filters.value = value
}
function open(id: string) {
  void router.push(collectionRoute(id))
}
</script>

<template>
  <section class="related" aria-label="关联的收藏">
    <h2 class="title">关联的收藏</h2>
    <p v-if="totalStorageBytes !== undefined" class="storage">
      帖子占用总量 {{ storageSize(totalStorageBytes) }}
    </p>
    <CollectionView
      :items="items"
      :query="query"
      :loading="loading"
      :error="error"
      :next="next"
      :total="total"
      :show-sensitive="showSensitive"
      :reposted-by="repostedBy"
      within-profile
      enlarged-media
      @search="search"
      @open="open"
      @more="more"
      @retry="load(request)"
      @deleted="
        (ids, withPosts) => {
          void refresh()
          emit('deleted', ids, withPosts)
        }
      "
    >
      <template #actions>
        <button
          type="button"
          :disabled="loading || refreshing"
          @click="refresh"
        >
          {{ refreshing ? '刷新中…' : '刷新' }}
        </button>
      </template>
    </CollectionView>
    <!-- Below the whole list: the posts it lacks come after the last one. -->
    <ListSection v-if="older && !next && !loading && !error" class="older">
      <ListButton
        label="抓取更早的帖子"
        :disabled="olderBusy"
        @select="emit('older')"
      />
    </ListSection>
  </section>
</template>

<style scoped>
.related {
  margin-top: 24px;
}
.title {
  margin: 0 0 8px;
  padding: 0 calc(var(--gutter) + 4px);
  font-size: 17px;
}
.older {
  margin-top: 12px;
}
.storage {
  margin: 0 0 12px;
  padding: 0 calc(var(--gutter) + 4px);
  font-size: 13px;
  color: var(--subtle);
}
</style>
