<script setup vapor lang="ts">
import { computed, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useCollection } from '../composables/useCollection'
import { storageSize } from '../presentation'
import CollectionView from './CollectionView.vue'
const props = defineProps<{
  id: string
  revisionId: string
  showSensitive?: boolean
  /** This profile's display name, shown on the posts it reposted. */
  repostedBy?: string
}>()
const router = useRouter()
const layout = shallowRef('')
const order = shallowRef<'asc' | 'desc'>('desc')
const query = computed(() => {
  const q = new URLSearchParams({
    related_to: props.id,
    entity_type: 'x.post',
    sort: 'published',
    order: order.value,
  })
  if (layout.value) q.set('layout', layout.value)
  return q.toString()
})
const { items, next, loading, error, totalStorageBytes, load, more } =
  useCollection()
watch(
  () => [props.id, props.revisionId, order.value],
  () => load(query.value),
  { immediate: true },
)
function search(value: string) {
  layout.value = new URLSearchParams(value).get('layout') || ''
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
      <span>发布时间</span>
      <button
        type="button"
        :aria-label="`发布时间排序：${order === 'desc' ? '倒序，切换为正序' : '正序，切换为倒序'}`"
        @click="order = order === 'desc' ? 'asc' : 'desc'"
      >
        {{ order === 'desc' ? '倒序 ↓' : '正序 ↑' }}
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
      hide-filters
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
.storage {
  margin: 0 0 12px;
  padding: 0 calc(var(--gutter) + 4px);
  font-size: 13px;
  color: var(--subtle);
}
</style>
