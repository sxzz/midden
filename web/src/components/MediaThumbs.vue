<script setup vapor lang="ts">
import { computed, shallowRef, watch } from 'vue'
import { assetURL, type Asset } from '../api'
import { readyMedia } from '../presentation'
import ImageViewer from './ImageViewer.vue'
import LoadingImage from './ui/LoadingImage.vue'
const props = defineProps<{ assets: Asset[]; showSensitive?: boolean }>()
const emit = defineEmits<{ open: [] }>()
const selected = shallowRef<Asset>()
const revealed = shallowRef<string[]>([])
const images = computed(() =>
  media.value.filter(
    (asset) =>
      asset.mime?.startsWith('image/') &&
      (!asset.sensitive ||
        props.showSensitive ||
        revealed.value.includes(asset.id)),
  ),
)
function view(asset: Asset) {
  if (!asset.mime?.startsWith('image/')) {
    emit('open')
    return
  }
  if (
    asset.sensitive &&
    !props.showSensitive &&
    !revealed.value.includes(asset.id)
  ) {
    revealed.value = [...revealed.value, asset.id]
  }
  selected.value = asset
}
watch(
  () => [props.assets, props.showSensitive],
  () => {
    selected.value = undefined
    revealed.value = []
  },
)
const LIMIT = 4
const media = computed(() => readyMedia(props.assets))
const tiles = computed(() => media.value.slice(0, LIMIT))
const overflow = computed(() => media.value.length - tiles.value.length)
</script>

<template>
  <span v-if="tiles.length" class="thumbs">
    <button
      v-for="(asset, index) in tiles"
      :key="asset.id"
      type="button"
      class="tile"
      :aria-label="
        asset.mime?.startsWith('image/')
          ? asset.sensitive && !showSensitive
            ? '查看敏感图片'
            : '放大图片'
          : '查看收藏详情'
      "
      :class="{ blurred: asset.sensitive && !showSensitive }"
      @click.stop="view(asset)"
    >
      <LoadingImage
        v-if="asset.mime?.startsWith('image/')"
        :src="assetURL(asset)"
        alt=""
        loading="lazy"
        decoding="async"
      />
      <video
        v-else-if="asset.mime?.startsWith('video/')"
        :src="`${assetURL(asset)}#t=0.1`"
        muted
        playsinline
        preload="metadata"
      />
      <span v-else class="veil">文件</span>
      <span v-if="asset.sensitive && !showSensitive" class="sensitive-label"
        >敏感</span
      >
      <span v-if="overflow && index === tiles.length - 1" class="more"
        >+{{ overflow }}</span
      >
    </button>
  </span>
  <ImageViewer
    v-if="selected"
    :images="images"
    :initial-id="selected.id"
    @close="selected = undefined"
  />
</template>

<style scoped>
.thumbs {
  display: flex;
  width: max-content;
  max-width: 100%;
  gap: 4px;
  margin-top: 8px;
}
.tile {
  position: relative;
  display: grid;
  place-items: center;
  width: 54px;
  height: 54px;
  flex-shrink: 0;
  border-radius: 8px;
  overflow: hidden;
  background: var(--fill);
}
.tile :deep(.image-shell),
.tile video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.tile :deep(.image-shell) {
  min-height: 0;
}
.tile.blurred :deep(img),
.tile.blurred video {
  filter: blur(8px);
  transform: scale(1.2);
}
.sensitive-label {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.25);
  color: #fff;
  font-size: 12px;
}
.veil {
  font-size: 12px;
  color: var(--subtle);
}
.play {
  font-size: 16px;
}
.more {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 14px;
}
</style>
