<script setup vapor lang="ts">
import { computed } from 'vue'
import { previewURL, type Collection } from '../api'
import {
  collectionTime,
  excerpt,
  markedExcerpt,
  present,
  shortDate,
  sourceStateNotice,
  storageSize,
} from '../presentation'
import { collectionRoute } from '../share'
import MediaThumbs from './MediaThumbs.vue'
import PostRelations from './PostRelations.vue'
import AppLink from './ui/AppLink.vue'
import LoadingImage from './ui/LoadingImage.vue'
import LockIcon from './ui/LockIcon.vue'
import TightText from './ui/TightText.vue'
const props = defineProps<{
  enlargedMedia?: boolean
  collection: Collection
  showSensitive?: boolean
  sort?: string
  /** Display name of the account this list belongs to, for its reposts. */
  repostedBy?: string
  /** Set while the list is selecting; the row then toggles instead of opening. */
  selected?: boolean
  /** Search terms to mark in the preview. */
  highlight?: string[]
}>()
const emit = defineEmits<{ toggle: [id: string] }>()
const selectable = computed(() => props.selected !== undefined)
// Captured before the row's own buttons and links, so none of them opens
// anything while the list is selecting.
function select(event: Event) {
  if (!selectable.value) return
  event.preventDefault()
  event.stopPropagation()
  emit('toggle', props.collection.id)
}
const view = computed(() => present(props.collection))
// Only a saved `reposted` relation to the list's own account makes this row a
// repost. Whoever wrote the post is never evidence of one.
const reposter = computed(() =>
  props.collection.relation_types?.includes('reposted')
    ? props.repostedBy
    : undefined,
)
// A post previews its own text and a profile its own bio, around what a
// search found in it.
const preview = computed(() =>
  props.highlight?.length
    ? markedExcerpt(view.value.bio ?? view.value.body, props.highlight)
    : [{ text: excerpt(view.value.bio ?? view.value.body), mark: false }],
)
const when = computed(() =>
  shortDate(
    props.sort
      ? collectionTime(props.collection, props.sort)
      : props.collection.saved_at || props.collection.observed_at,
  ),
)
const meta = computed(() =>
  [
    sourceStateNotice(props.collection),
    // The banner above the post already names the account that reposted it.
    !reposter.value &&
      props.collection.relation_types?.includes('reposted') &&
      '转发',
    props.collection.relation_types?.includes('mentions') && '提及',
  ]
    .filter(Boolean)
    .join(' · '),
)
const storage = computed(() =>
  props.collection.storage_bytes === undefined
    ? ''
    : storageSize(props.collection.storage_bytes),
)
</script>

<template>
  <div
    class="row"
    :class="{ selectable, selected }"
    :role="selectable ? 'checkbox' : undefined"
    :aria-checked="selectable ? selected : undefined"
    :tabindex="selectable ? 0 : undefined"
    @click.capture="select"
    @keydown.space="select"
    @keydown.enter="select"
  >
    <!-- The repost line is a row of its own across the whole item, so the
         avatar and the name below it stay the original author's. -->
    <span v-if="reposter" class="repost">
      <svg
        class="repost-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <polyline points="17 2 21 6 17 10" />
        <path d="M3 12V10a4 4 0 0 1 4-4h14" />
        <polyline points="7 22 3 18 7 14" />
        <path d="M21 12v2a4 4 0 0 1-4 4H3" />
      </svg>
      <span class="repost-text">{{ reposter }} 已转发</span>
    </span>
    <span class="post">
      <span v-if="selectable" class="check" aria-hidden="true">
        <svg v-if="selected" viewBox="0 0 24 24" width="14" height="14">
          <path
            d="m5 12.5 4.5 4.5L19 7.5"
            fill="none"
            stroke="currentColor"
            stroke-width="2.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </span>
      <AppLink
        :href="view.profileHref"
        class="avatar-link"
        :aria-label="`查看${view.name}的主页`"
        ><LoadingImage
          v-if="view.avatar && (!view.avatar.sensitive || showSensitive)"
          class="avatar"
          :src="previewURL(view.avatar)"
          alt=""
          loading="lazy"
        /><span
          v-else
          class="avatar initials"
          aria-hidden="true"
          :lang="view.nameLang"
          >{{ view.name.slice(0, 1) }}</span
        ></AppLink
      >
      <span class="content">
        <!-- The whole row is this link; see .head::after. -->
        <AppLink :to="collectionRoute(collection.id)" class="head">
          <span class="identity"
            ><strong class="name" :lang="view.nameLang">{{ view.name }}</strong
            ><LockIcon v-if="view.locked" class="lock" /><span
              v-if="view.handle"
              class="handle"
              >@{{ view.handle }}</span
            ></span
          ><span class="when">{{ when }}</span>
        </AppLink>
        <span
          v-if="preview.length && preview[0]!.text"
          class="preview"
          :lang="view.lang"
          ><template v-for="(part, i) in preview" :key="i"
            ><mark v-if="part.mark"><TightText :text="part.text" /></mark
            ><TightText v-else :text="part.text" /></template
        ></span>
        <span v-if="meta" class="meta">{{ meta }}</span>
        <PostRelations
          :collection="collection"
          :show-sensitive="showSensitive"
          compact
        />
        <MediaThumbs
          :size="enlargedMedia ? 'medium' : 'small'"
          :desktop-size="enlargedMedia ? 'large' : 'medium'"
          :collection-id="collection.id"
          :collection="collection"
          :assets="collection.assets || []"
          :show-sensitive="showSensitive"
        />
        <span v-if="storage" class="storage">{{ storage }}</span>
      </span>
    </span>
  </div>
</template>

<style scoped>
.avatar-link {
  align-self: flex-start;
  display: block;
  width: 40px;
  height: 40px;
  flex-shrink: 0;
}
.head {
  color: inherit;
  text-decoration: none;
}
/* The row's surface opens the collection as a link of its own would: a new
   tab on Cmd/Ctrl or the middle button, its address in the context menu.
   What else in the row is a link or a button sits above it. */
.head::after {
  content: '';
  position: absolute;
  inset: 0;
}
.avatar-link,
.content :deep(.relations a),
.content :deep(.thumbs-group) {
  position: relative;
  z-index: 1;
}
.row {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  padding: 11px var(--inset);
  background: none;
}
.row + .row::before {
  content: '';
  position: absolute;
  inset: 0 0 auto calc(var(--inset) + 52px);
  height: 1px;
  background: var(--separator);
}
.row:active {
  background: var(--fill);
}
.row.selectable {
  cursor: pointer;
}
/* Line the separator up with the avatar, past the check column. */
.row.selectable + .row.selectable::before {
  left: calc(var(--inset) + 86px);
}
.row.selectable:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: -2px;
}
.check {
  display: grid;
  place-items: center;
  align-self: center;
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1.5px var(--subtle);
  color: #fff;
}
.selected .check {
  background: var(--link);
  box-shadow: none;
}
.post {
  display: flex;
  gap: 12px;
}
.avatar {
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  border-radius: 50%;
  object-fit: cover;
  background: var(--fill);
}
.image-shell.avatar {
  min-height: 0;
}
.initials {
  display: grid;
  place-items: center;
  font-size: 17px;
  font-weight: 600;
  color: var(--link);
}
.content {
  flex: 1;
  min-width: 0;
}
.repost {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 5px;
  font-size: 13px;
  line-height: 1.3;
  color: var(--subtle);
}
.repost-icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}
.preview mark {
  border-radius: 3px;
  background: color-mix(in srgb, var(--link) 22%, transparent);
  color: inherit;
}
.repost-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.head {
  width: 100%;
  background: none;
  display: flex;
  align-items: baseline;
  gap: 8px;
}
/* The name and the handle share one shrinking column, so the time keeps its
   place at the right however long either of them is. */
.identity {
  display: flex;
  align-items: baseline;
  gap: 5px;
  flex: 1;
  min-width: 0;
}
.name {
  min-width: 0;
  font-size: 16px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Tucked against the name the way X shows a protected account. */
.lock {
  align-self: center;
  margin-left: -3px;
  font-size: 15px;
}
.handle {
  min-width: 0;
  /* The handle gives up room first: the name identifies the account. */
  flex-shrink: 8;
  font-size: 14px;
  color: var(--subtle);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.when {
  flex-shrink: 0;
  font-size: 13px;
  color: var(--subtle);
}
.preview {
  text-wrap: pretty;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin-top: 2px;
  font-size: 15px;
  line-height: 1.45;
  color: var(--text);
}
.meta {
  display: block;
  margin-top: 3px;
  font-size: 13px;
  color: var(--subtle);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Sits in the flow after the media, so it can never cover a thumbnail. */
.storage {
  display: block;
  margin-top: 4px;
  text-align: right;
  font-size: 12px;
  color: var(--subtle);
}
@media (min-width: 768px) {
  .preview {
    -webkit-line-clamp: 4;
    line-clamp: 4;
  }
}
</style>
