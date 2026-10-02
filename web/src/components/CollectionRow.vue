<script setup vapor lang="ts">
import { computed } from 'vue'
import { assetURL, type Collection } from '../api'
import {
  collectionTime,
  excerpt,
  present,
  shortDate,
  storageSize,
} from '../presentation'
import MediaThumbs from './MediaThumbs.vue'
import PostRelations from './PostRelations.vue'
import LoadingImage from './ui/LoadingImage.vue'
const props = defineProps<{
  collection: Collection
  showSensitive?: boolean
  sort?: string
  /** Display name of the account this list belongs to, for its reposts. */
  repostedBy?: string
  /** Set while the list is selecting; the row then toggles instead of opening. */
  selected?: boolean
}>()
const emit = defineEmits<{ open: [id: string]; toggle: [id: string] }>()
const selectable = computed(() => props.selected !== undefined)
// Captured before the row's own buttons and links, so none of them opens
// anything while the list is selecting.
function select(event: Event) {
  if (!selectable.value) return
  event.preventDefault()
  event.stopPropagation()
  emit('toggle', props.collection.id)
}
function open(event: MouseEvent) {
  if (selectable.value) return
  if (
    event.target instanceof Element &&
    event.target.closest('button, dialog, a')
  )
    return
  emit('open', props.collection.id)
}
const view = computed(() => present(props.collection))
// Only a saved `reposted` relation to the list's own account makes this row a
// repost. Whoever wrote the post is never evidence of one.
const reposter = computed(() =>
  props.collection.relation_types?.includes('reposted')
    ? props.repostedBy
    : undefined,
)
// A post previews its own text and a profile its own bio.
const preview = computed(() => excerpt(view.value.bio ?? view.value.body))
const when = computed(() =>
  shortDate(
    props.sort
      ? collectionTime(props.collection, props.sort)
      : props.collection.saved_at || props.collection.observed_at,
  ),
)
const meta = computed(() =>
  [
    props.collection.visibility === 'private' && '私密',
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
    @click="open"
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
      <LoadingImage
        v-if="view.avatar && (!view.avatar.sensitive || showSensitive)"
        class="avatar"
        :src="assetURL(view.avatar)"
        alt=""
        loading="lazy"
      /><span v-else class="avatar initials" aria-hidden="true">{{
        view.name.slice(0, 1)
      }}</span>
      <span class="content">
        <button
          type="button"
          class="head"
          @click.stop="$emit('open', collection.id)"
        >
          <span class="identity"
            ><strong class="name">{{ view.name }}</strong
            ><span v-if="view.handle" class="handle"
              >@{{ view.handle }}</span
            ></span
          ><span class="when">{{ when }}</span>
        </button>
        <span v-if="preview" class="preview">{{ preview }}</span>
        <span v-if="meta" class="meta">{{ meta }}</span>
        <PostRelations :collection="collection" compact />
        <MediaThumbs
          :collection-id="collection.id"
          :assets="collection.assets || []"
          :show-sensitive="showSensitive"
          @open="$emit('open', collection.id)"
        />
        <span v-if="storage" class="storage">{{ storage }}</span>
      </span>
    </span>
  </div>
</template>

<style scoped>
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
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin-top: 2px;
  font-size: 15px;
  line-height: 1.45;
  color: var(--subtle);
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
</style>
