<script setup vapor lang="ts">
import { onBeforeUnmount, onMounted, shallowRef, useTemplateRef } from 'vue'
import { assetURL, previewURL, type Asset } from '../api'
import LoadingImage from './ui/LoadingImage.vue'
const props = withDefaults(
  defineProps<{
    asset: Asset
    alt?: string
    fit?: 'cover' | 'contain'
    /** Load at once, as the post being read does. */
    eager?: boolean
    /** Show the small derived image where one exists, as lists do. */
    thumbnail?: boolean
  }>(),
  { fit: 'cover' },
)
const root = useTemplateRef<HTMLElement>('root')
// Media shares the visitor's bandwidth with API requests, so it starts only
// close to the viewport. Native lazy loading begins far earlier.
const near = shallowRef(
  props.eager || typeof IntersectionObserver === 'undefined',
)
let observer: IntersectionObserver | undefined
onMounted(() => {
  if (near.value || !root.value) return
  observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      near.value = true
      observer?.disconnect()
    },
    { rootMargin: '200px' },
  )
  observer.observe(root.value)
})
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <span ref="root" class="media-preview" :style="{ '--media-fit': fit }">
    <span v-if="!near" class="pending" aria-hidden="true" />
    <!-- A video is never fetched for a preview: each one would pull the whole
         file from storage. Its poster stands for it, or a plain box until the
         viewer, which plays it, is opened. -->
    <LoadingImage
      v-else-if="asset.mime?.startsWith('video/') && asset.thumbnail_url"
      :src="asset.thumbnail_url"
      :alt="alt || ''"
    />
    <span
      v-else-if="asset.mime?.startsWith('video/')"
      class="pending"
      aria-hidden="true"
    />
    <LoadingImage
      v-else-if="thumbnail && asset.thumbnail"
      :src="previewURL(asset)"
      :alt="alt || ''"
    />
    <LoadingImage
      v-else-if="asset.mime?.startsWith('image/')"
      :src="assetURL(asset)"
      :alt="alt || ''"
    />
  </span>
</template>

<style scoped>
.media-preview {
  display: block;
  width: 100%;
  height: var(--media-height, 100%);
  overflow: hidden;
  border-radius: inherit;
}
.media-preview :deep(.image-shell) {
  display: block;
  width: 100%;
  height: var(--media-height, 100%);
  min-height: 0;
  object-fit: var(--media-fit);
}
.pending {
  display: block;
  height: var(--media-height, 100%);
  background: var(--fill);
}
.media-preview :deep(img) {
  height: var(--media-height, 100%);
  object-fit: var(--media-fit);
}
</style>
