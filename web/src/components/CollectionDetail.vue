<script setup vapor lang="ts">
import { computed, shallowRef, watch } from 'vue'
import {
  call,
  client,
  errorText,
  safeURL,
  type Asset,
  type Collection,
  type RemovalEffect,
  type RemovalTarget,
  type Share,
  type VideoRemoval,
  type Watch,
} from '../api'
import { useAside } from '../aside'
import { profileHandle } from '../captures'
import { useCollectionDetail } from '../composables/useCollectionDetail'
import { toast } from '../composables/useToast'
import { useVideoRemoval } from '../composables/useVideoRemoval'
import { useWatch } from '../composables/useWatch'
import {
  mediaRemovals,
  mediaRemoved,
  withRemovedMedia,
} from '../media-removals'
import { date, isRemoved, present } from '../presentation'
import { accountKey, relationQuery, type Rel } from '../relation-filter'
import { isProfileEntity } from '../relations'
import { collectionRoute, shareSlug } from '../share'
import { rememberKind } from '../titles'
import CollectionAnnotations from './CollectionAnnotations.vue'
import CollectionPost from './CollectionPost.vue'
import DeleteSheet from './DeleteSheet.vue'
import MediaRemovalSheet from './MediaRemovalSheet.vue'
import ProfileCollections from './ProfileCollections.vue'
import RevisionTimeline from './RevisionTimeline.vue'
import ShareSheet from './ShareSheet.vue'
import AppLink from './ui/AppLink.vue'
import CollectionSkeleton from './ui/CollectionSkeleton.vue'
import ListButton from './ui/ListButton.vue'
import ListSection from './ui/ListSection.vue'
import UpdateSheet from './UpdateSheet.vue'
import VideoRemovalSheet from './VideoRemovalSheet.vue'
import WatchSheet from './WatchSheet.vue'
const props = defineProps<{
  id: string
  savedAt?: string
  showSensitive?: boolean
}>()
const emit = defineEmits<{
  /** This collection is deleted; `withPosts` when its posts went too. */
  deleted: [id: string, withPosts: boolean]
  /** Collections listed under it were deleted. */
  removed: [ids: string[], withPosts: boolean]
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
  preview,
  reload,
  update,
  started,
  updating,
  older,
  checkAvailability,
  membersVersion,
} = useCollectionDetail(
  () => props.id,
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
// The frame's title names what this is once it is known.
watch(collection, (value) => value && rememberKind(value), { immediate: true })
const isProfile = computed(() =>
  collection.value?.graph?.entities.some(
    (entity) =>
      entity.key === collection.value?.graph?.root && isProfileEntity(entity),
  ),
)
/**
 * Each follow count opens the library's accounts under the 关系 filter from
 * this profile; behind a share they stay plain numbers, as the share
 * refuses the filter.
 */
const followLinks = computed(() => {
  const root = collection.value?.graph?.entities.find(
    (entity) => entity.key === collection.value?.graph?.root,
  )
  if (shareSlug.value || !root || !isProfileEntity(root)) return undefined
  const key = accountKey(root)
  const to = (rel: Rel) => ({
    name: 'collections',
    query: relationQuery(key, rel),
  })
  return {
    following: to('following'),
    followers: to('followers'),
    mutual: to('mutual'),
  }
})
const followRows = [
  { rel: 'following', label: '关注' },
  { rel: 'followers', label: '粉丝' },
  { rel: 'mutual', label: '互关' },
] as const
// The related list is this profile's own timeline, so the posts it holds by a
// repost relation were reposted by this profile and say so.
const profileName = computed(() =>
  collection.value ? present(collection.value).name : '',
)
const link = computed(() => collection.value && safeURL(collection.value.url))
const handle = computed(() =>
  collection.value
    ? profileHandle(collection.value.url, present(collection.value).handle)
    : '',
)
/**
 * A profile's history is read on its 资料修改记录 page, with the timeline
 * through its versions; the page is there once either has anything.
 */
const changesPage = computed(
  () => isProfile.value && (changeable.value || points.value.length > 1),
)
/** Whether the first group lists anything; behind a share it may not. */
const pages = computed(
  () =>
    trendable.value ||
    changesPage.value ||
    followChangeable.value ||
    !!follows.value ||
    !!link.value,
)
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
/** The update sheet, with the options that apply to this collection. */
const updateSheet = shallowRef(false)
watch(
  () => props.id,
  () => (updateSheet.value = false),
)
function startUpdate() {
  updateSheet.value = true
}
function updateStarted(recordId: string) {
  updateSheet.value = false
  started(recordId)
}
/** A profile's 定期更新, edited in a sheet of its own. */
const {
  trailing: watchTrailing,
  hint: watchHint,
  changed: watchSaved,
} = useWatch(() =>
  isProfile.value && !shared.value
    ? { target: 'collection', id: props.id }
    : undefined,
)
// The desktop sidebar shows what this page loaded, beside it.
useAside(() => ({
  id: props.id,
  collection: collection.value,
  savedAt: savedAt.value,
  follows: follows.value,
  points: points.value,
  morePoints: !!next.value,
  record: record.value,
  updating: updating.value,
  pages: {
    stats: trendable.value,
    changes: !!changesPage.value,
    follows: followChangeable.value,
  },
  watch: watchTrailing.value
    ? { label: watchTrailing.value, hint: watchHint.value }
    : undefined,
}))
const watchSheet = shallowRef(false)
watch(
  () => props.id,
  () => (watchSheet.value = false),
)
function watchChanged(w: Watch | undefined) {
  watchSaved(w)
  watchSheet.value = false
}
/** The removal being confirmed: all of a post's media. */
const removal = shallowRef<{ target: RemovalTarget; title: string }>()
watch(
  () => props.id,
  () => (removal.value = undefined),
)
/** A post's media still stored or to be stored, for 删除此帖所有媒体. */
const removable = computed(
  () =>
    !isProfile.value &&
    !!collection.value?.assets.some((asset) => !isRemoved(asset)),
)
function removeAll() {
  removal.value = {
    target: { ids: [props.id] },
    title: '删除此帖所有媒体？',
  }
}
/** 删除所有视频 of a profile: its confirmation, then the job it starts. */
const videoSheet = shallowRef(false)
watch(
  () => props.id,
  () => (videoSheet.value = false),
)
const videoRemoval = useVideoRemoval(() =>
  isProfile.value && !shared.value ? props.id : undefined,
)
const videoProgress = computed(() => {
  const running = videoRemoval.running.value
  return running?.effect
    ? `${running.removed} / ${running.effect.videos}`
    : undefined
})
function videoRemovalStarted(removal: VideoRemoval) {
  videoSheet.value = false
  videoRemoval.started(removal)
}
// Media removed from the viewer, opened here or from a list.
watch(mediaRemovals, () => {
  void reload()
})
// One media item removed from the viewer shows as removed in place.
watch(mediaRemoved, (change) => {
  const shown = collection.value
  if (change && shown?.id === change.collection)
    collection.value = withRemovedMedia(shown, change.asset, change.effect)
})
function removed(effect: RemovalEffect) {
  removal.value = undefined
  toast(`已删除 ${effect.media} 个媒体`)
  void reload()
}
/**
 * 恢复 / 恢复下载: the original comes back as it was, linked back at once or
 * downloaded again from its own address, never by capturing the post or
 * profile again. Read again, the item shows, or shows 下载中 over its kept
 * thumbnail until the download is in (followed by `useCollectionDetail`).
 */
async function restore(asset: Asset) {
  try {
    await call(
      client['media-removals'].restore.$post({
        json: { collection: props.id, asset: asset.id },
      }),
    )
  } catch (e) {
    toast(errorText(e))
    return
  }
  void reload()
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
        :editable="!shared"
        @restore="restore"
      />
    </ListSection>
    <ListSection v-if="follows" title="关系网">
      <!-- What stored follows say, not the profile's own counts. -->
      <dl class="follows">
        <div v-for="row in followRows" :key="row.rel">
          <dt>{{ row.label }}</dt>
          <dd>
            <!-- The whole tile is the link; see .follow-link::after. -->
            <AppLink
              v-if="followLinks"
              :to="followLinks[row.rel]"
              class="follow-link"
              :aria-label="`${row.label} ${follows[row.rel]}，在收藏库中查看`"
              >{{ follows[row.rel] }}</AppLink><template v-else>{{
              follows[row.rel]
            }}</template>
          </dd>
        </div>
      </dl>
    </ListSection>
    <!-- A profile's timeline is on its 资料修改记录 page. -->
    <ListSection v-if="!isProfile && points.length > 1" title="内容变化">
      <RevisionTimeline
        :points="points"
        :selected-id="shownPoint"
        :latest-id="latestPoint"
        :more="!!next"
        :loading="historyLoading"
        label="内容版本"
        @select="preview"
        @more="historyPage(true)"
      />
    </ListSection>
    <!-- The update in a group of its own, first: the button that starts it
         and the progress of the running or latest one, over the date of the
         version on screen. -->
    <ListSection v-if="!shared" class="update" :footnote="version">
      <ListButton
        :label="updating ? '正在更新…' : '更新'"
        :disabled="busy || updating || loadingPoint || !available"
        @select="startUpdate"
      />
      <ListButton
        v-if="record"
        label="查看进度"
        chevron
        :to="{ name: 'capture', params: { id: record } }"
      />
      <ListButton
        v-if="isProfile"
        label="定期更新"
        :hint="watchHint"
        :trailing="watchTrailing"
        chevron
        @select="watchSheet = true"
      />
      <ListButton
        v-if="!available"
        label="重试连接采集服务"
        @select="checkAvailability"
      />
    </ListSection>
    <!-- Behind a public link there is no update, so the date goes here. -->
    <ListSection
      v-if="pages || !shared"
      :footnote="shared ? version : undefined"
    >
      <ListButton
        v-if="trendable"
        label="统计趋势"
        chevron
        :to="collectionRoute(id, 'stats')"
      />
      <ListButton
        v-if="changesPage"
        label="资料修改记录"
        chevron
        :to="collectionRoute(id, 'changes')"
      />
      <ListButton
        v-if="followChangeable"
        label="关注变化"
        chevron
        :to="collectionRoute(id, 'follows')"
      />
      <ListButton
        v-if="follows"
        label="关系图谱"
        chevron
        :to="collectionRoute(id, 'graph')"
      />
      <ListButton v-if="link" label="打开原文" :href="link" />
      <ListButton
        v-if="!shared"
        label="公开分享"
        :hint="exposureHint"
        :trailing="sharedDirectly ? '已公开' : undefined"
        @select="sharing = true"
      />
    </ListSection>
    <!-- The reader's own notes, folded, then the destructive actions. -->
    <ListSection v-if="!shared">
      <CollectionAnnotations
        :id="id"
        :key="id"
        @saved="emit('annotationsSaved')"
      />
      <ListButton
        v-if="removable"
        label="删除此帖所有媒体"
        variant="destructive"
        :disabled="busy"
        @select="removeAll"
      />
      <ListButton
        v-if="isProfile"
        :label="videoRemoval.running.value ? '正在删除视频…' : '删除所有视频'"
        :trailing="videoProgress"
        variant="destructive"
        :disabled="busy || !!videoRemoval.running.value"
        @select="videoSheet = true"
      />
      <ListButton
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
      :older="older && !shared"
      :older-busy="busy || updating || !available"
      @older="update({ older: true })"
      @deleted="(ids, withPosts) => emit('removed', ids, withPosts)"
    />
    <UpdateSheet
      v-if="!shared"
      :open="updateSheet"
      :target="{ target: 'collection', id }"
      :label="isProfile ? handle : undefined"
      @started="updateStarted"
      @cancel="updateSheet = false"
    />
    <WatchSheet
      v-if="!shared && isProfile"
      :open="watchSheet"
      :target="{ target: 'collection', id }"
      :label="handle"
      @changed="watchChanged"
      @navigate="watchSheet = false"
      @cancel="watchSheet = false"
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
    <MediaRemovalSheet
      v-if="!shared"
      :open="!!removal"
      :target="removal?.target ?? { ids: [id] }"
      :title="removal?.title ?? ''"
      @removed="removed"
      @cancel="removal = undefined"
    />
    <VideoRemovalSheet
      v-if="!shared && isProfile"
      :id="id"
      :open="videoSheet"
      @started="videoRemovalStarted"
      @cancel="videoSheet = false"
    />
    <DeleteSheet
      v-if="!shared"
      :open="confirmDelete"
      :ids="[id]"
      :title="isProfile ? '删除这个账号？' : '删除这条收藏？'"
      @deleted="(withPosts) => emit('deleted', id, withPosts)"
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
  position: relative;
  flex: 1;
  text-align: center;
}
.follow-link {
  color: var(--link);
  text-decoration: none;
}
.follow-link::after {
  content: '';
  position: absolute;
  inset: 0;
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
