<script setup vapor lang="ts">
import { computed, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useCollection } from '../composables/useCollection'
import { storageSize } from '../presentation'
import CollectionView from './CollectionView.vue'
const props = defineProps<{
  id: string
  revisionId: string
  platform?: string
  /** Bumped when a refresh of this profile saved new or updated posts. */
  membersVersion?: number
  showSensitive?: boolean
  /** This profile's display name, shown on the posts it reposted. */
  repostedBy?: string
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
  void router.push({ name: 'collection', params: { id } })
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
      :show-sensitive="showSensitive"
      :reposted-by="repostedBy"
      within-profile
      enlarged-media
      @search="search"
      @open="open"
      @more="more"
      @retry="load(request)"
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
.storage {
  margin: 0 0 12px;
  padding: 0 calc(var(--gutter) + 4px);
  font-size: 13px;
  color: var(--subtle);
}
</style>
