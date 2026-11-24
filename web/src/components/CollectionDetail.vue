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
  follows,
  followChangeable,
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
/** An X profile: its update can also fetch its lists (抓关系网). */
const isXProfile = computed(
  () =>
    collection.value?.graph?.entities.find(
      (entity) => entity.key === collection.value?.graph?.root,
    )?.type === 'x.profile',
)
/** Unchecked on every visit: fetching the lists costs many requests. */
const withRelations = shallowRef(false)
watch(
  () => props.id,
  () => (withRelations.value = false),
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
function openFollows() {
  void router.push({ name: 'collection-follows', params: { id: props.id } })
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
    // An answer without a list, as from an older server, shows nothing.
    if (id === props.id) exposure.value = Array.isArray(found) ? found : []
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
  void refresh({ relations: isXProfile.value && withRelations.value })
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
    <ListSection v-if="follows" title="关系网">
      <!-- What stored follows say, not the profile's own counts. -->
      <dl class="follows">
        <div>
          <dt>关注</dt>
          <dd>{{ follows.following }}</dd>
        </div>
        <div>
          <dt>粉丝</dt>
          <dd>{{ follows.followers }}</dd>
        </div>
        <div>
          <dt>互关</dt>
          <dd>{{ follows.mutual }}</dd>
        </div>
      </dl>
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
      <ListButton
        v-if="followChangeable"
        label="关注变化"
        chevron
        @select="openFollows"
      />
      <ListButton v-if="link" label="打开原文" :href="link" />
      <ListButton
        v-if="!shared"
        label="公开分享"
        :hint="exposureHint"
        :trailing="sharedDirectly ? '已公开' : undefined"
        @select="sharing = true"
      />
      <!-- Options of the update, right above the button that starts it. -->
      <label v-if="isXProfile && !shared" class="option"
        ><span>抓关系网</span
        ><input
          v-model="withRelations"
          class="switch"
          type="checkbox"
          role="switch"
          :disabled="busy"
      /></label>
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
.follows {
  display: flex;
  margin: 0;
  padding: 12px var(--inset);
}
.follows div {
  flex: 1;
  text-align: center;
}
.follows dt {
  font-size: 13px;
  color: var(--subtle);
}
.follows dd {
  margin: 2px 0 0;
  font-size: 17px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 48px;
  margin-left: var(--inset);
  padding: 6px var(--inset) 6px 0;
  font-size: 16px;
  /* Separated from the rows around it like they are from each other. */
  box-shadow:
    inset 0 1px 0 var(--separator),
    inset 0 -1px 0 var(--separator);
}
/* The switch of the capture options, for one option of an update. */
.switch {
  appearance: none;
  -webkit-appearance: none;
  position: relative;
  flex: none;
  width: 46px;
  height: 28px;
  margin: 0;
  border-radius: 14px;
  background: var(--fill);
  cursor: pointer;
  transition: background 160ms ease;
}
.switch::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
  transition: transform 160ms ease;
}
.switch:checked {
  background: var(--link);
}
.switch:checked::after {
  transform: translateX(18px);
}
.switch:disabled {
  opacity: 0.5;
  cursor: default;
}
.switch:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: 2px;
}
@media (prefers-reduced-motion: reduce) {
  .switch,
  .switch::after {
    transition: none;
  }
}
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
