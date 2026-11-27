<script setup vapor lang="ts">
import { computed, watch } from 'vue'
import { readCollection } from '../reads'
import { collectionRoute, type HistoryTab } from '../share'
import { kindOf, rememberKind } from '../titles'
import CollectionTrends from './CollectionTrends.vue'
import FollowChanges from './FollowChanges.vue'
import ProfileChanges from './ProfileChanges.vue'
import PageTabs from './ui/PageTabs.vue'
/**
 * 历史 of an account: one page with a tab for each of its records, each tab
 * an address of its own (router.ts), as 采集's tabs are. 资料 is what its
 * profile said over time, 数据 its counts, 关注 the changes in its follows.
 * A post has only its counts: no tabs, the page is 统计趋势.
 */
const props = defineProps<{
  id: string
  tab: HistoryTab
  showSensitive?: boolean
}>()
const kind = computed(() => kindOf(props.id))
// Opened by its address alone, the kind is not known yet: read it once, as
// the detail page would.
watch(
  () => props.id,
  async (id) => {
    if (kindOf(id)) return
    try {
      rememberKind(await readCollection(id))
    } catch {
      // The tab's own content says what failed.
    }
  },
  { immediate: true },
)
const tabs = computed(() =>
  (
    [
      { tab: 'profile', label: '资料', page: 'history' },
      { tab: 'data', label: '数据', page: 'history-data' },
      { tab: 'follows', label: '关注', page: 'history-follows' },
    ] as const
  ).map((t) => ({
    label: t.label,
    to: collectionRoute(props.id, t.page),
    on: t.tab === props.tab,
  })),
)
</script>

<template>
  <PageTabs v-if="kind === 'profile'" label="历史" :tabs="tabs" />
  <ProfileChanges
    v-if="tab === 'profile'"
    :id="id"
    :show-sensitive="showSensitive"
  />
  <CollectionTrends v-else-if="tab === 'data'" :id="id" />
  <FollowChanges v-else :id="id" :show-sensitive="showSensitive" />
</template>
