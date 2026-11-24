<script setup vapor lang="ts">
import { computed, onUnmounted, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import { safeURL, type Collection } from '../api'
import { useCollectionDetail } from '../composables/useCollectionDetail'
import { date, present } from '../presentation'
import { isProfileEntity } from '../relations'
import CollectionAnnotations from './CollectionAnnotations.vue'
import CollectionPost from './CollectionPost.vue'
import ConfirmSheet from './ConfirmSheet.vue'
import ProfileCollections from './ProfileCollections.vue'
import RevisionTimeline from './RevisionTimeline.vue'
import CollectionSkeleton from './ui/CollectionSkeleton.vue'
import ListButton from './ui/ListButton.vue'
import ListSection from './ui/ListSection.vue'
const props = defineProps<{
  id: string
  savedAt?: string
  showSensitive?: boolean
}>()
const emit = defineEmits<{
  deleted: [id: string]
  updated: [collection: Collection]
  annotationsSaved: []
}>()
const {
  collection,
  error,
  busy,
  status,
  points,
  next,
  historical,
  latestPoint,
  shownPoint,
  latestRevision,
  historyLoading,
  loadingPoint,
  confirmDelete,
  available,
  trendable,
  historyPage,
  showPoint,
  isSeen,
  remove,
  refresh,
  checkAvailability,
  membersVersion,
} = useCollectionDetail(
  () => props.id,
  (id) => emit('deleted', id),
  (collection) => emit('updated', collection),
)
// A historical revision does not carry the collection's own save date, so keep
// the last one we learned and hand it to the post.
const savedAt = shallowRef(props.savedAt)
watch(
  () => props.savedAt || collection.value?.saved_at,
  (value) => {
    if (value) savedAt.value = value
  },
  { immediate: true },
)
const isProfile = computed(() =>
  collection.value?.graph?.entities.some(
    (entity) =>
      entity.key === collection.value?.graph?.root && isProfileEntity(entity),
  ),
)
// The related list is this profile's own timeline, so the posts it holds by a
// repost relation were reposted by this profile and say so.
const profileName = computed(() =>
  collection.value ? present(collection.value).name : '',
)
const link = computed(() => collection.value && safeURL(collection.value.url))
const router = useRouter()
function openTrends() {
  void router.push({ name: 'collection-stats', params: { id: props.id } })
}
// Dragging the timeline passes many points: show the ones already fetched at
// once, and fetch the others only where the drag rests.
let pick: ReturnType<typeof setTimeout> | undefined
onUnmounted(() => clearTimeout(pick))
function preview(point: string) {
  clearTimeout(pick)
  if (isSeen(point)) void showPoint(point)
  else pick = setTimeout(showPoint, 150, point)
}
function startRefresh() {
  void refresh()
}
const version = computed(() =>
  collection.value
    ? `${historical.value ? '历史' : '最新'}版本抓取于 ${date(collection.value.observed_at)}`
    : '',
)
</script>

<template>
  <ListSection v-if="error" plain>
    <p class="banner" role="alert">{{ error }}</p>
  </ListSection>
  <ListSection v-if="!collection && !error"
    ><CollectionSkeleton detail
  /></ListSection>
  <template v-if="collection">
    <ListSection>
      <!-- The collection stays on screen while the timeline fetches a
           point, so what changed between the two reads as a change. -->
      <CollectionPost
        :class="{ fetching: loadingPoint }"
        :collection="collection"
        :saved-at="savedAt"
        :show-sensitive="showSensitive"
      />
    </ListSection>
    <ListSection
      v-if="points.length > 1"
      :title="isProfile ? '资料变化' : '内容变化'"
    >
      <RevisionTimeline
        :points="points"
        :selected-id="shownPoint"
        :latest-id="latestPoint"
        :more="!!next"
        :loading="historyLoading"
        :label="isProfile ? '资料版本' : '内容版本'"
        @select="preview"
        @more="historyPage(true)"
      />
    </ListSection>
    <ListSection :footnote="version">
      <ListButton
        v-if="trendable"
        label="统计趋势"
        chevron
        @select="openTrends"
      />
      <ListButton v-if="link" label="打开原文" :href="link" />
      <ListButton
        label="重新抓取"
        :disabled="busy || loadingPoint || !available"
        @select="startRefresh"
      />
      <ListButton
        v-if="!available"
        label="重试连接采集服务"
        @select="checkAvailability"
      />
      <!-- The reader's own notes, folded, then the one destructive action:
           every action on this collection in one card. -->
      <CollectionAnnotations
        :id="id"
        :key="id"
        @saved="emit('annotationsSaved')"
      />
      <ListButton
        label="删除这条收藏"
        variant="destructive"
        :disabled="busy"
        @select="confirmDelete = true"
      />
    </ListSection>
    <p class="status" :class="{ quiet: !status }" role="status">{{ status }}</p>
    <ProfileCollections
      v-if="isProfile"
      :id="id"
      :revision-id="latestRevision"
      :platform="
        collection?.graph?.entities.find(
          (entity) => entity.key === collection?.graph?.root,
        )?.type === 'instagram.profile'
          ? 'instagram'
          : 'x'
      "
      :members-version="membersVersion"
      :show-sensitive="showSensitive"
      :reposted-by="profileName"
    />
    <ConfirmSheet
      :open="confirmDelete"
      title="删除这条收藏？"
      confirm-label="删除"
      :busy="busy"
      @confirm="remove"
      @cancel="confirmDelete = false"
    />
  </template>
</template>

<style scoped>
.banner {
  margin: 0;
  padding: 14px var(--inset);
  border-radius: var(--radius);
  background: var(--card);
  font-size: 15px;
  line-height: 1.5;
}
.loading,
.status {
  margin: 0 0 16px;
  padding: 0 calc(var(--gutter) + 4px);
  font-size: 13px;
  line-height: 1.5;
  color: var(--subtle);
}
.loading {
  padding-top: 32px;
  text-align: center;
}
.fetching {
  opacity: 0.6;
  transition: opacity 0.2s ease 0.1s;
}
.status.quiet {
  margin: 0;
}
</style>
