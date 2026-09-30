<script setup vapor lang="ts">
import { computed, shallowRef, watch } from 'vue'
import { readyMedia } from '../presentation'
import MediaPreview from './MediaPreview.vue'
import MediaViewer from './MediaViewer.vue'
import type { Asset } from '../api'
const props = defineProps<{ assets: Asset[]; showSensitive?: boolean }>()
const emit = defineEmits<{ open: [] }>()
const selected = shallowRef<Asset>()
const revealed = shallowRef<string[]>([])
const previews = computed(() =>
  media.value.filter(
    (asset) =>
      (asset.mime?.startsWith('image/') || asset.mime?.startsWith('video/')) &&
      (!asset.sensitive ||
        props.showSensitive ||
        revealed.value.includes(asset.id)),
  ),
)
function view(asset: Asset) {
  if (!asset.mime?.startsWith('image/') && !asset.mime?.startsWith('video/')) {
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
          : asset.mime?.startsWith('video/')
            ? asset.sensitive && !showSensitive
              ? '查看敏感视频'
              : '播放视频'
            : '查看收藏详情'
      "
      :class="{ blurred: asset.sensitive && !showSensitive }"
      @click.stop="view(asset)"
    >
      <MediaPreview
        v-if="
          asset.mime?.startsWith('image/') || asset.mime?.startsWith('video/')
        "
        :asset="asset"
      />
      <span v-else class="veil">文件</span>
      <span
        v-if="asset.mime?.startsWith('video/')"
        class="play"
        aria-hidden="true"
        >▶</span
      >
      <span v-if="asset.sensitive && !showSensitive" class="sensitive-label"
        >敏感</span
      >
      <span v-if="overflow && index === tiles.length - 1" class="more"
        >+{{ overflow }}</span
      >
    </button>
  </span>
  <MediaViewer
    v-if="selected"
    :assets="previews"
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
  position: absolute;
  color: white;
  pointer-events: none;
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
