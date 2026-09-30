<script setup vapor lang="ts">
import { computed, shallowRef, watch } from 'vue'
import { assetURL, type Asset } from '../api'
import { mediaNotice } from '../presentation'
import MediaPreview from './MediaPreview.vue'
import MediaViewer from './MediaViewer.vue'
const props = defineProps<{ assets: Asset[]; showSensitive?: boolean }>()
const selected = shallowRef<Asset>()
function view(asset: Asset) {
  selected.value = asset
}
const revealed = shallowRef<string[]>([])
watch(
  () => props.showSensitive,
  (show) => {
    if (!show) {
      revealed.value = []
      if (selected.value?.sensitive) {
        selected.value = undefined
      }
    }
  },
)
function hidden(asset: Asset) {
  return (
    asset.sensitive &&
    !props.showSensitive &&
    !revealed.value.includes(asset.id)
  )
}
function reveal(id: string) {
  revealed.value = [...revealed.value, id]
}
const previews = computed(() =>
  props.assets.filter(
    (asset) =>
      asset.state === 'ready' &&
      (asset.mime?.startsWith('image/') || asset.mime?.startsWith('video/')) &&
      (!asset.sensitive ||
        props.showSensitive ||
        revealed.value.includes(asset.id)),
  ),
)
watch(
  () => props.assets,
  () => {
    selected.value = undefined
    revealed.value = []
  },
)
</script>

<template>
  <div v-if="assets.length" class="media">
    <figure v-for="asset in assets" :key="asset.id" class="item">
      <p v-if="asset.state !== 'ready'" class="notice">
        {{ mediaNotice(asset) }}
      </p>
      <button
        v-else-if="
          asset.mime?.startsWith('image/') || asset.mime?.startsWith('video/')
        "
        type="button"
        class="frame"
        :class="{ sensitive: hidden(asset) }"
        :aria-label="
          hidden(asset)
            ? '敏感内容 · 点按显示'
            : asset.mime?.startsWith('video/')
              ? '播放视频'
              : '放大图片'
        "
        @click="hidden(asset) ? reveal(asset.id) : view(asset)"
      >
        <MediaPreview
          :asset="asset"
          fit="contain"
          :alt="asset.alt_text"
          :class="{ blurred: hidden(asset) }"
        />
        <span v-if="hidden(asset)" class="sensitive-label"
          >敏感内容 · 点按显示</span
        >
        <span
          v-else-if="asset.mime?.startsWith('video/')"
          class="play"
          aria-hidden="true"
          >▶</span
        >
      </button>
      <a v-else class="download" :href="assetURL(asset, false)">下载文件</a>
    </figure>
  </div>
  <MediaViewer
    v-if="selected"
    :assets="previews"
    :initial-id="selected.id"
    @close="selected = undefined"
  />
</template>

<style scoped>
.media {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px;
  margin-top: 12px;
}
.media:has(.item:only-child) {
  grid-template-columns: 1fr;
}
.item {
  margin: 0;
  min-width: 0;
}
.frame {
  position: relative;
  display: block;
  width: 100%;
  aspect-ratio: 1;
  padding: 0;
  overflow: hidden;
  border-radius: 8px;
  background: var(--fill);
}
.frame .blurred {
  transform: scale(1.12);
}
.frame :deep(.blurred img),
.frame :deep(.blurred video) {
  filter: blur(18px);
}
.play,
.sensitive-label {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  background: rgba(0, 0, 0, 0.55);
  color: white;
  pointer-events: none;
}
.play {
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  border-radius: 50%;
}
.sensitive-label {
  width: max-content;
  max-width: 95%;
  padding: 8px;
  border-radius: 20px;
  font-size: 12px;
}
.notice,
.download {
  display: block;
  margin: 0;
  padding: 14px;
  border-radius: 8px;
  background: var(--fill);
  color: var(--subtle);
  font-size: 14px;
}
</style>
