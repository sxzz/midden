<script setup vapor lang="ts">
import { computed, onUnmounted, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import { call, client, safeURL, type Collection, type Share } from '../api'
import { useCollectionDetail } from '../composables/useCollectionDetail'
import { date, present } from '../presentation'
import { isProfileEntity } from '../relations'
import { collectionRoute, shareSlug } from '../share'
import CollectionAnnotations from './CollectionAnnotations.vue'
import CollectionPost from './CollectionPost.vue'
import ConfirmSheet from './ConfirmSheet.vue'
import ProfileCollections from './ProfileCollections.vue'
import RevisionTimeline from './RevisionTimeline.vue'
import ShareSheet from './ShareSheet.vue'
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
  record,
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
  changeable,
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
  void router.push(collectionRoute(props.id, 'stats'))
}
function openChanges() {
  void router.push(collectionRoute(props.id, 'changes'))
}
// Behind a public link the page only reads: no capture, notes or deletion.
const shared = computed(() => !!shareSlug.value)
/** The owner's links that make this collection public, so none surprises. */
const exposure = shallowRef<Share[]>([])
const sharing = shallowRef(false)
async function loadExposure() {
  if (shared.value) return
  const id = props.id
  try {
    const found = await call(client.shares.$get({ query: { collection: id } }))
    if (id === props.id) exposure.value = found
  } catch {
    // Without an answer the row only offers to share.
  }
}
watch(
  () => props.id,
  () => {
    exposure.value = []
    void loadExposure()
  },
  { immediate: true },
)
const sharedDirectly = computed(() =>
  exposure.value.some(
    (s) => s.target === 'collection' && s.target_id === props.id,
  ),
)
const exposureHint = computed(() => {
  const folders = exposure.value
    .filter((s) => s.target === 'folder')
    .map((s) => `「${s.name}」`)
  const profile = exposure.value.some(
    (s) => s.target === 'collection' && s.target_id !== props.id,
  )
  return [
    folders.length && `已随收藏夹${folders.join('')}公开`,
    profile && '已随所在账号公开',
  ]
    .filter(Boolean)
    .join('；')
})
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
function openRecord() {
  void router.push({ name: 'capture', params: { id: record.value } })
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
      <ListButton
        v-if="changeable"
        label="资料修改记录"
        chevron
        @select="openChanges"
      />
      <ListButton v-if="link" label="打开原文" :href="link" />
      <ListButton
        v-if="!shared"
        label="公开分享"
        :hint="exposureHint"
        :trailing="sharedDirectly ? '已公开' : undefined"
        @select="sharing = true"
      />
      <ListButton
        v-if="!shared"
        label="重新抓取"
        :disabled="busy || loadingPoint || !available"
        @select="startRefresh"
      />
      <ListButton v-if="record" label="查看进度" chevron @select="openRecord" />
      <ListButton
        v-if="!available && !shared"
        label="重试连接采集服务"
        @select="checkAvailability"
      />
      <!-- The reader's own notes, folded, then the one destructive action:
           every action on this collection in one card. -->
      <CollectionAnnotations
        v-if="!shared"
        :id="id"
        :key="id"
        @saved="emit('annotationsSaved')"
      />
      <ListButton
        v-if="!shared"
        label="删除这条收藏"
        variant="destructive"
        :disabled="busy"
        @select="confirmDelete = true"
      />
    </ListSection>
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
    <ShareSheet
      v-if="!shared"
      :id="id"
      :open="sharing"
      target="collection"
      :title="isProfile ? '公开分享这个账号' : '公开分享这条收藏'"
      @changed="loadExposure"
      @cancel="sharing = false"
    />
    <ConfirmSheet
      v-if="!shared"
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
.fetching {
  opacity: 0.6;
  transition: opacity 0.2s ease 0.1s;
}
</style>
