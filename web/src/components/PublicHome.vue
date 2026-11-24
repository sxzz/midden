<script setup lang="ts">
import { computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useCollection } from '../composables/useCollection'
import { listsProfiles } from '../presentation'
import { collectionRoute } from '../share'
import CollectionDetail from './CollectionDetail.vue'
import CollectionView from './CollectionView.vue'
import CollectionSkeleton from './ui/CollectionSkeleton.vue'
import ListSection from './ui/ListSection.vue'
import type { PublicShareInfo } from '../api'
// What a public link opens: the shared collection's page, or the shared
// folder's list, with a tab per kind only when it holds both. The visitor's
// filters, order and tab live in the address, so a filtered view can be
// linked; the accounts tab is written as its entity types, as on the home
// page.
const props = defineProps<{
  share?: PublicShareInfo
  showSensitive?: boolean
}>()
const route = useRoute()
const router = useRouter()
const PROFILES = 'x.profile,instagram.profile'
const tabs = [
  { value: 'post', label: '帖子' },
  { value: 'profile', label: '账号' },
] as const
type Kind = (typeof tabs)[number]['value']
/** The address's query while this page is shown; kept while away from it. */
const address = computed<string>((previous) =>
  route.name === 'share'
    ? route.fullPath.split('?')[1]?.split('#')[0] || ''
    : (previous ?? ''),
)
const onlyProfiles = computed(
  () => !props.share?.posts && !!props.share?.profiles,
)
const kind = computed<Kind>(() =>
  listsProfiles(address.value) ||
  (onlyProfiles.value && !new URLSearchParams(address.value).has('entity_type'))
    ? 'profile'
    : 'post',
)
const both = computed(() => !!props.share?.posts && !!props.share?.profiles)
/** The list's query: the address, with the accounts tab when it is implied. */
const query = computed(() => {
  const q = new URLSearchParams(address.value)
  if (kind.value === 'profile' && !listsProfiles(q))
    q.set('entity_type', PROFILES)
  return q.toString()
})
const { items, next, total, loading, error, load, more } = useCollection()
const folder = computed(() => props.share?.target === 'folder')
// The layout is not part of what is listed.
const listed = computed(() => {
  const q = new URLSearchParams(query.value)
  q.delete('layout')
  return q.toString()
})
watch(
  () => folder.value && listed.value,
  (value) => {
    if (value !== false) void load(query.value)
  },
  { immediate: true },
)
function search(value: string) {
  const slug = String(route.params.slug)
  void router.push(`/s/${slug}${value ? `?${value}` : ''}`)
}
/** Another tab starts over, as on the home page. */
function pick(value: Kind) {
  if (value === kind.value) return
  search(value === 'profile' ? `entity_type=${PROFILES}` : '')
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
        @click="pick(option.value)"
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
      :total="total"
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
