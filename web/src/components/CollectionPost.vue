<script setup vapor lang="ts">
import { computed, shallowRef, watch } from 'vue'
import { previewURL, type Asset, type Collection } from '../api'
import {
  date,
  isRemoved,
  isRestoring,
  mentionParts,
  present,
  restoreLabel,
  sourceStateNotice,
  storageSize,
  warningList,
} from '../presentation'
import { collectionHref } from '../share'
import MediaGallery from './MediaGallery.vue'
import MediaViewer from './MediaViewer.vue'
import PostRelations from './PostRelations.vue'
import AppLink from './ui/AppLink.vue'
import LoadingImage from './ui/LoadingImage.vue'
import LockIcon from './ui/LockIcon.vue'
const props = defineProps<{
  collection: Collection
  /** When the viewer already knows it, so revisions never drop the date. */
  savedAt?: string
  showSensitive?: boolean
  /** The owner's page: removed media can be restored. */
  editable?: boolean
  /**
   * A point of a profile's history: only what can change between points,
   * none of the record's own facts (保存于, UID, UUID, 占用), the source's
   * current state or the capture's warnings.
   */
  history?: boolean
}>()
const emit = defineEmits<{ restore: [asset: Asset] }>()
// Authors read as their newest profile unless asked for the captured one.
const captured = shallowRef(false)
const view = computed(() =>
  present(props.collection, { captured: captured.value }),
)
const notice = computed(() =>
  props.history ? '' : sourceStateNotice(props.collection),
)
const bodyParts = computed(() =>
  mentionParts(props.collection, view.value.body),
)
/** "Saved at" belongs with the other timestamps, right after the source's
    own publication date, rather than in a separate footnote. */
const details = computed(() => {
  if (props.history) return []
  const list = [...view.value.details]
  if (props.collection.storage_bytes !== undefined)
    list.push({
      key: 'storage',
      label: '占用',
      value: storageSize(props.collection.storage_bytes),
    })
  const savedAt = props.savedAt || props.collection.saved_at
  const value = date(savedAt)
  if (!value || list.some((detail) => detail.key === 'saved')) return list
  const published = list.findIndex((detail) => detail.key === 'published')
  const merged = [...list]
  merged.splice(published + 1, 0, {
    key: 'saved',
    label: '保存于',
    value,
    datetime: savedAt,
  })
  return merged
})
const previewAvatar = shallowRef(false)
const avatarAssets = computed(() =>
  view.value.avatar && (!view.value.avatar.sensitive || props.showSensitive)
    ? [view.value.avatar]
    : [],
)
/** Only an avatar saved here opens in the viewer; a remote one just shows. */
const viewable = computed(() => avatarAssets.value[0]?.state === 'ready')
watch(avatarAssets, () => {
  previewAvatar.value = false
})
// The banner follows the avatar's rules: a sensitive one is left out until
// sensitive media is shown, and only one saved here opens in the viewer.
// Without one there is no band at all: an empty grey slab 3:1 tall says
// nothing and pushes the bio down, so the header stays as a post's.
const previewBanner = shallowRef(false)
const bannerAssets = computed(() =>
  view.value.banner && (!view.value.banner.sensitive || props.showSensitive)
    ? [view.value.banner]
    : [],
)
const bannerViewable = computed(() => bannerAssets.value[0]?.state === 'ready')
/** A removed banner (or one downloading again) keeps its box, as media does. */
const bannerKept = computed(() => {
  const banner = bannerAssets.value[0]
  return banner && (isRemoved(banner) || isRestoring(banner))
    ? banner
    : undefined
})
watch(bannerAssets, () => {
  previewBanner.value = false
})
const warnings = computed(() =>
  props.history ? [] : warningList(props.collection.warnings),
)
</script>

<template>
  <article class="post" :class="{ 'with-cover': bannerAssets.length }">
    <!-- The box keeps the platform's 3:1 before the image arrives. -->
    <div v-if="bannerAssets.length" class="cover">
      <button
        v-if="bannerViewable"
        type="button"
        class="cover-button"
        :aria-label="`查看${view.name}的主页封面`"
        @click="previewBanner = true"
      >
        <LoadingImage
          class="cover-image"
          :src="previewURL(bannerAssets[0]!)"
          alt=""
          loading="eager"
        />
      </button>
      <div v-else-if="bannerKept" class="cover-kept">
        <LoadingImage
          v-if="bannerKept.thumbnail_url"
          class="cover-image"
          :src="bannerKept.thumbnail_url"
          alt=""
          loading="eager"
        />
        <span v-if="isRestoring(bannerKept)" class="cover-label" role="status"
          >下载中</span
        >
        <span v-else class="cover-label">
          已移除
          <button
            v-if="editable"
            type="button"
            class="cover-restore"
            @click="emit('restore', bannerKept)"
          >
            {{ restoreLabel(bannerKept) }}
          </button>
        </span>
      </div>
      <LoadingImage
        v-else
        class="cover-image"
        :src="previewURL(bannerAssets[0]!)"
        alt=""
        loading="eager"
      />
    </div>
    <header class="author">
      <AppLink
        v-if="view.bio === undefined && view.profileHref"
        :href="view.profileHref"
        class="avatar"
        :aria-label="`查看${view.name}的主页`"
        ><LoadingImage
          v-if="avatarAssets.length"
          class="avatar"
          :src="previewURL(avatarAssets[0]!)"
          alt=""
        /><span v-else class="avatar initials">{{
          view.name.slice(0, 1)
        }}</span></AppLink
      >
      <button
        v-else-if="viewable && view.bio !== undefined"
        type="button"
        class="avatar avatar-button"
        :aria-label="`查看${view.name}的头像`"
        @click="previewAvatar = true"
      >
        <LoadingImage
          class="avatar"
          :src="previewURL(avatarAssets[0]!)"
          alt=""
        /></button
      ><LoadingImage
        v-else-if="avatarAssets.length"
        class="avatar"
        :src="previewURL(avatarAssets[0]!)"
        alt=""
      /><span v-else class="avatar initials" aria-hidden="true">{{
        view.name.slice(0, 1)
      }}</span>
      <a
        v-if="view.profileCollectionId"
        class="identity profile-link"
        :href="collectionHref(view.profileCollectionId)"
      >
        <strong class="name"
          >{{ view.name }}<LockIcon v-if="view.locked" class="lock"
        /></strong>
        <small v-if="view.handle" class="handle">@{{ view.handle }}</small>
      </a>
      <div v-else class="identity">
        <strong class="name"
          >{{ view.name }}<LockIcon v-if="view.locked" class="lock"
        /></strong>
        <small v-if="view.handle" class="handle">@{{ view.handle }}</small>
      </div>
      <button
        v-if="view.profileChanged"
        type="button"
        class="profile-version"
        :aria-pressed="captured"
        @click="captured = !captured"
      >
        {{ captured ? '最新资料' : '抓取时资料' }}
      </button>
    </header>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <p v-if="view.body" class="body">
      <template v-for="(part, index) in bodyParts" :key="index"
        ><a v-if="part.href" :href="part.href" class="mention">{{
          part.text
        }}</a
        ><template v-else>{{ part.text }}</template></template
      >
    </p>
    <MediaGallery
      :assets="collection.assets || []"
      :collection="collection"
      :show-sensitive="showSensitive"
      :editable="editable"
      @restore="(asset) => emit('restore', asset)"
    />
    <PostRelations
      :collection="collection"
      :captured="captured"
      :show-sensitive="showSensitive"
    />
    <p v-for="warning in warnings" :key="warning" class="warning">
      {{ warning }}
    </p>
    <footer v-if="view.stats || details.length" class="record">
      <dl v-if="view.stats" class="stats" :aria-label="view.stats.label">
        <div v-for="stat in view.stats.items" :key="stat.label" class="stat">
          <dt>{{ stat.label }}</dt>
          <dd>{{ stat.value }}</dd>
        </div>
      </dl>
      <p v-if="details.length" class="details">
        <span
          v-for="detail in details"
          :key="detail.key"
          class="detail"
          :class="{ identifier: detail.key === 'uid' || detail.key === 'uuid' }"
          ><span v-if="detail.label" class="label">{{ detail.label }}</span
          ><time v-if="detail.datetime" :datetime="detail.datetime">{{
            detail.value
          }}</time
          ><span v-else :class="{ uuid: detail.key === 'uuid' }">{{
            detail.value
          }}</span></span
        >
      </p>
    </footer>
    <MediaViewer
      v-if="previewAvatar && avatarAssets.length"
      :assets="avatarAssets"
      :initial-id="avatarAssets[0]!.id"
      :collection-id="view.profileCollectionId"
      @close="previewAvatar = false"
    />
    <MediaViewer
      v-if="previewBanner && bannerAssets.length"
      :assets="bannerAssets"
      :initial-id="bannerAssets[0]!.id"
      @close="previewBanner = false"
    />
  </article>
</template>

<style scoped>
.mention {
  color: var(--link);
}
.post {
  padding: 14px var(--inset) 16px;
}
.author {
  display: flex;
  gap: 12px;
  align-items: center;
}
.avatar {
  width: 44px;
  height: 44px;
  flex-shrink: 0;
  border-radius: 50%;
  object-fit: cover;
  background: var(--fill);
}
.avatar-button {
  padding: 0;
}
/* The banner runs edge to edge over the card's padding, and the avatar
   sits half on it, ringed in the card's colour, with the name below. */
.with-cover {
  padding-top: 0;
}
.cover {
  margin: 0 calc(-1 * var(--inset));
  aspect-ratio: 3 / 1;
  background: var(--fill);
}
.cover-button {
  display: block;
  width: 100%;
  height: 100%;
  padding: 0;
}
.cover-button:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: -2px;
}
/* A removed banner: its kept thumbnail, dimmed under a small label. */
.cover-kept {
  position: relative;
  display: grid;
  place-items: center;
  height: 100%;
}
.cover-kept .cover-image {
  position: absolute;
  inset: 0;
  opacity: 0.45;
}
.cover-label {
  position: relative;
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 4px 10px;
  border-radius: 12px;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  font-size: 13px;
}
.cover-restore {
  padding: 0;
  color: #fff;
  font-size: 13px;
  font-weight: 600;
}
.image-shell.cover-image {
  width: 100%;
  height: 100%;
  min-height: 0;
  border-radius: 0;
  object-fit: cover;
}
.with-cover .author {
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
}
.with-cover .avatar {
  width: 72px;
  height: 72px;
}
.with-cover .author > .avatar {
  position: relative;
  margin-top: -36px;
  box-shadow: 0 0 0 3px var(--card);
}
.with-cover .avatar.initials {
  font-size: 28px;
}
.avatar-button:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: 3px;
}
.image-shell.avatar {
  min-height: 0;
}
.initials {
  display: grid;
  place-items: center;
  font-size: 18px;
  font-weight: 600;
  color: var(--link);
}
.identity {
  min-width: 0;
  flex: 1;
}
.name {
  display: block;
  font-size: 16px;
  font-weight: 600;
}
.lock {
  margin-left: 3px;
}
.handle {
  display: block;
  font-size: 13px;
  color: var(--subtle);
}
.profile-link {
  color: inherit;
  text-decoration: none;
}
.profile-link:hover .name {
  color: var(--link);
}
.profile-link:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: 4px;
  border-radius: 4px;
}
.body {
  margin: 12px 0 0;
  font-size: 16px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
/* Shown right under the author, before content that is no longer online. */
.notice {
  margin: 10px 0 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--destructive);
}
.profile-version {
  flex-shrink: 0;
  padding: 0;
  font-size: 13px;
  color: var(--link);
}
.warning {
  margin: 10px 0 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--subtle);
}
/* What the source recorded, kept under the post behind a hairline. */
.record {
  margin-top: 14px;
  padding-top: 11px;
  border-top: 1px solid var(--separator);
}
/* Wrap whole statistics into new rows, never split a number. */
.stats {
  display: flex;
  flex-wrap: wrap;
  gap: 16px 12px;
  margin: 0;
}
/* Counts and timeline are two layers, so separate them when both are here. */
.stats:not(:last-child) {
  margin-bottom: 12px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--separator);
}
/* Count above, label below: the number is what the reader scans for. */
.stat {
  display: flex;
  flex-direction: column-reverse;
  gap: 2px;
  flex: 1 0 88px;
}
.stat dt {
  font-size: 12px;
  line-height: 1.3;
  color: var(--subtle);
  overflow-wrap: anywhere;
}
.stat dd {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
@media (max-width: 360px) {
  .stat dd {
    font-size: 16px;
  }
}
.details {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--subtle);
}
/* One fact per line: fixed label column on the left, value on the right. */
.detail {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr);
  column-gap: 8px;
  align-items: baseline;
}
.detail.identifier {
  font-size: 12px;
}
.detail > :last-child {
  grid-column: 2;
  min-width: 0;
  overflow-wrap: anywhere;
}
.uuid {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
.detail time {
  font-variant-numeric: tabular-nums;
}
</style>
