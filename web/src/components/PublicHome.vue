<script setup lang="ts">
import { computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useCollection } from '../composables/useCollection'
import { listsProfiles } from '../presentation'
import CollectionDetail from './CollectionDetail.vue'
import CollectionView from './CollectionView.vue'
import CollectionSkeleton from './ui/CollectionSkeleton.vue'
import ListSection from './ui/ListSection.vue'
import PageTabs from './ui/PageTabs.vue'
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
const { items, next, total, loading, refreshing, error, load, refresh, more } =
  useCollection()
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
/** Another tab starts over, as on the home page; the shown one stays. */
function tabLink(value: Kind) {
  if (value === kind.value) return route.fullPath
  const slug = String(route.params.slug)
  return `/s/${slug}${value === 'profile' ? `?entity_type=${PROFILES}` : ''}`
}
/** 帖子 and 账号 as X's tabs, as on the owner's library. */
const pageTabs = computed(() =>
  tabs.map((option) => ({
    label: option.label,
    to: tabLink(option.value),
    on: kind.value === option.value,
  })),
)
</script>

<template>
  <ListSection v-if="!share"><CollectionSkeleton detail /></ListSection>
  <CollectionDetail
    v-else-if="share.target === 'collection'"
    :id="share.collection_id!"
    :show-sensitive="showSensitive"
  />
  <template v-else>
    <PageTabs v-if="both" label="类型" :tabs="pageTabs" />
    <CollectionView
      :items="items"
      :query="query"
      :loading="loading"
      :error="error"
      :next="next"
      :total="total"
      :show-sensitive="showSensitive"
      :refreshing="refreshing"
      aside-filters
      @search="search"
      @refresh="refresh"
      @more="more"
      @retry="load(query)"
    />
  </template>
</template>
