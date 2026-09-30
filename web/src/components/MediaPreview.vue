<script setup vapor lang="ts">
import { assetURL, type Asset } from '../api'
import LoadingImage from './ui/LoadingImage.vue'
withDefaults(
  defineProps<{ asset: Asset; alt?: string; fit?: 'cover' | 'contain' }>(),
  { fit: 'cover' },
)
</script>

<template>
  <span class="media-preview" :style="{ '--media-fit': fit }">
    <LoadingImage
      v-if="asset.mime?.startsWith('image/')"
      :src="assetURL(asset)"
      :alt="alt || ''"
    />
    <video
      v-else-if="asset.mime?.startsWith('video/')"
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
  height: 100%;
  overflow: hidden;
  border-radius: inherit;
}
.media-preview :deep(.image-shell),
.media-preview video {
  display: block;
  width: 100%;
  height: 100%;
  min-height: 0;
  object-fit: var(--media-fit);
}
.media-preview :deep(img) {
  object-fit: var(--media-fit);
}
</style>
