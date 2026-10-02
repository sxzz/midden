<script setup vapor lang="ts">
import { onBeforeUnmount, onMounted, shallowRef, useTemplateRef } from 'vue'
import { assetURL, type Asset } from '../api'
import LoadingImage from './ui/LoadingImage.vue'
const props = withDefaults(
  defineProps<{
    asset: Asset
    alt?: string
    fit?: 'cover' | 'contain'
    /** Load at once, as the post being read does. */
    eager?: boolean
  }>(),
  { fit: 'cover' },
)
const root = useTemplateRef<HTMLElement>('root')
const video = useTemplateRef<HTMLVideoElement>('video')
// Media shares the visitor's bandwidth with API requests, so it starts only
// close to the viewport. Native lazy loading begins far earlier, and video
// has no lazy loading at all: `preload` alone starts every one at once.
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
onBeforeUnmount(() => {
  observer?.disconnect()
  // A removed video keeps downloading until its source is dropped.
  const element = video.value
  if (element) {
    element.removeAttribute('src')
    element.load()
  }
})
</script>

<template>
  <span ref="root" class="media-preview" :style="{ '--media-fit': fit }">
    <span v-if="!near" class="pending" aria-hidden="true" />
    <LoadingImage
      v-else-if="asset.mime?.startsWith('image/')"
      :src="assetURL(asset)"
      :alt="alt || ''"
    />
    <video
      v-else-if="asset.mime?.startsWith('video/')"
      ref="video"
      :src="`${assetURL(asset)}#t=0.1`"
      muted
      playsinline
      preload="metadata"
      aria-hidden="true"
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
.media-preview :deep(.image-shell),
.media-preview video {
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
