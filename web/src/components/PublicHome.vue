<script setup lang="ts">
import { computed, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useCollection } from '../composables/useCollection'
import { collectionRoute } from '../share'
import CollectionDetail from './CollectionDetail.vue'
import CollectionView from './CollectionView.vue'
import CollectionSkeleton from './ui/CollectionSkeleton.vue'
import ListSection from './ui/ListSection.vue'
import type { PublicShareInfo } from '../api'
// What a public link opens: the shared collection's page, or the shared
// folder's list, with a tab per kind only when it holds both.
const props = defineProps<{
  share?: PublicShareInfo
  showSensitive?: boolean
}>()
const router = useRouter()
const tabs = [
  { value: 'post', label: '帖子', types: 'x.post,instagram.post' },
  { value: 'profile', label: '账号', types: 'x.profile,instagram.profile' },
] as const
type Kind = (typeof tabs)[number]['value']
const picked = shallowRef<Kind>()
const kind = computed<Kind>(
  () =>
    picked.value ??
    (!props.share?.posts && props.share?.profiles ? 'profile' : 'post'),
)
const both = computed(() => !!props.share?.posts && !!props.share?.profiles)
const layout = shallowRef('')
const query = computed(() => {
  const q = new URLSearchParams({
    entity_type: tabs.find((t) => t.value === kind.value)!.types,
  })
  if (layout.value) q.set('layout', layout.value)
  return q.toString()
})
const { items, next, loading, error, load, more } = useCollection()
const folder = computed(() => props.share?.target === 'folder')
watch(
  () => folder.value && kind.value,
  (value) => {
    if (value) void load(query.value)
  },
  { immediate: true },
)
function search(value: string) {
  // Only the layout can change here; the folder decides what is listed.
  layout.value = new URLSearchParams(value).get('layout') || ''
}
function open(id: string) {
  void router.push(collectionRoute(id))
}
</script>

<template>
  <ListSection v-if="!share"><CollectionSkeleton detail /></ListSection>
  <CollectionDetail
    v-else-if="share.target === 'collection'"
    :id="share.collection_id!"
    :show-sensitive="showSensitive"
  />
  <template v-else>
    <div v-if="both" class="tabs" role="tablist" aria-label="类型">
      <button
        v-for="option in tabs"
        :key="option.value"
        type="button"
        role="tab"
        class="tab"
        :class="{ on: kind === option.value }"
        :aria-selected="kind === option.value"
        @click="picked = option.value"
      >
        {{ option.label }}
      </button>
    </div>
    <CollectionView
      :items="items"
      :query="query"
      :loading="loading"
      :error="error"
      :next="next"
      :show-sensitive="showSensitive"
      @search="search"
      @open="open"
      @more="more"
      @retry="load(query)"
    />
  </template>
</template>

<style scoped>
.tabs {
  display: flex;
  gap: 2px;
  margin: 4px var(--gutter) 12px;
  padding: 2px;
  border-radius: 10px;
  background: var(--fill);
}
.tab {
  flex: 1;
  min-height: 32px;
  text-align: center;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  color: var(--subtle);
  transition:
    background 160ms ease,
    color 160ms ease;
}
.tab.on {
  background: var(--card);
  color: var(--text);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--text) 12%, transparent),
    0 1px 3px rgba(0, 0, 0, 0.12);
}
.tab:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: 1px;
}
</style>
