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
const filters = shallowRef('sort=published&order=desc')
const query = computed(() => {
  const q = new URLSearchParams(filters.value)
  q.set('related_to', props.id)
  if (!q.has('entity_type'))
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
  const q = new URLSearchParams(query.value)
  q.delete('layout')
  return q.toString()
})
watch(
  () => requestQuery.value,
  () => load(query.value),
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
    <div class="sort-control">
      <button
        type="button"
        class="soft-refresh"
        :disabled="loading || refreshing"
        @click="refresh"
      >
        {{ refreshing ? '刷新中…' : '刷新' }}
      </button>
    </div>
    <CollectionView
      :items="items"
      :query="query"
      :loading="loading"
      :error="error"
      :next="next"
      :show-sensitive="showSensitive"
      :reposted-by="repostedBy"
      hide-authors
      @search="search"
      @open="open"
      @more="more"
      @retry="load(query)"
    />
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
.sort-control {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 calc(var(--gutter) + 4px) 8px;
  color: var(--subtle);
  font-size: 13px;
}
.sort-control button {
  min-height: 32px;
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--fill);
  color: var(--text);
  font-size: inherit;
}
.sort-control .soft-refresh {
  margin-left: auto;
  color: var(--link);
}
.sort-control .soft-refresh:disabled {
  color: var(--subtle);
}
.storage {
  margin: 0 0 12px;
  padding: 0 calc(var(--gutter) + 4px);
  font-size: 13px;
  color: var(--subtle);
}
</style>
