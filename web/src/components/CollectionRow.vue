<script setup vapor lang="ts">
import { computed } from 'vue'
import { assetURL, type Collection } from '../api'
import {
  collectionTime,
  excerpt,
  mediaSummary,
  present,
  shortDate,
  storageSize,
} from '../presentation'
import MediaThumbs from './MediaThumbs.vue'
import LoadingImage from './ui/LoadingImage.vue'
const props = defineProps<{
  collection: Collection
  showSensitive?: boolean
  sort?: string
}>()
const emit = defineEmits<{ open: [id: string] }>()
function open(event: MouseEvent) {
  if (
    event.target instanceof Element &&
    event.target.closest('button, dialog, a')
  )
    return
  emit('open', props.collection.id)
}
const view = computed(() => present(props.collection))
const preview = computed(() => excerpt(view.value.body))
const meta = computed(() =>
  [
    view.value.handle && `@${view.value.handle}`,
    props.collection.visibility === 'private' && '私密',
    mediaSummary(props.collection.assets),
    props.collection.storage_bytes !== undefined &&
      storageSize(props.collection.storage_bytes),
  ]
    .filter(Boolean)
    .join(' · '),
)
</script>

<template>
  <div class="row" @click="open">
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
        <strong class="name">{{ view.name }}</strong
        ><span class="when">{{
          shortDate(
            sort
              ? collectionTime(collection, sort)
              : collection.saved_at || collection.observed_at,
          )
        }}</span>
      </button>
      <span class="preview">{{ preview }}</span>
      <span v-if="meta" class="meta">{{ meta }}</span>
      <MediaThumbs
        :collection-id="collection.id"
        :assets="collection.assets || []"
        :show-sensitive="showSensitive"
        @open="$emit('open', collection.id)"
      />
    </span>
  </div>
</template>

<style scoped>
.row {
  position: relative;
  display: flex;
  gap: 12px;
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
.head {
  width: 100%;
  background: none;
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.name {
  flex: 1;
  min-width: 0;
  font-size: 16px;
  font-weight: 600;
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
</style>
