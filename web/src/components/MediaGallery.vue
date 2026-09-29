<script setup vapor lang="ts">
import LoadingImage from "./ui/LoadingImage.vue";
import { computed, shallowRef, watch } from "vue";
import ImageViewer from "./ImageViewer.vue";
import { assetURL, type Asset } from "../api";
import { mediaNotice } from "../presentation";
const props = defineProps<{ assets: Asset[]; showSensitive?: boolean }>();
const selected = shallowRef<Asset>();
function view(asset: Asset) {
  selected.value = asset;
}
const revealed = shallowRef<string[]>([]);
watch(
  () => props.showSensitive,
  (show) => {
    if (!show) {
      revealed.value = [];
      if (selected.value?.sensitive) {
        selected.value = undefined;
      }
    }
  },
);
function reveal(id: string) {
  revealed.value = [...revealed.value, id];
}
const images = computed(() =>
  props.assets.filter(
    (asset) =>
      asset.state === "ready" &&
      asset.mime?.startsWith("image/") &&
      (!asset.sensitive ||
        props.showSensitive ||
        revealed.value.includes(asset.id)),
  ),
);
watch(
  () => props.assets,
  () => {
    selected.value = undefined;
    revealed.value = [];
  },
);
</script>
<template>
  <div v-if="assets.length" class="media">
    <figure v-for="asset in assets" :key="asset.id" class="item">
      <p v-if="asset.state !== 'ready'" class="notice">
        {{ mediaNotice(asset) }}
      </p>
      <!-- Keep the preview visible under the blur until explicitly revealed. -->
      <button
        v-else-if="
          asset.sensitive && !showSensitive && !revealed.includes(asset.id)
        "
        type="button"
        class="sensitive"
        @click="reveal(asset.id)"
      >
        <LoadingImage
          v-if="asset.mime?.startsWith('image/')"
          class="blurred"
          :src="assetURL(asset)"
          alt=""
          loading="lazy"
        />
        <video
          v-else-if="asset.mime?.startsWith('video/')"
          class="blurred"
          :src="assetURL(asset) + '#t=0.1'"
          muted
          playsinline
          preload="metadata"
          aria-hidden="true"
        />
        <span class="sensitive-label">敏感内容 · 点按显示</span>
      </button>
      <template v-else
        ><button
          v-if="asset.mime?.startsWith('image/')"
          type="button"
          class="frame"
          aria-label="放大图片"
          @click="view(asset)"
        >
          <LoadingImage
            :src="assetURL(asset)"
            :alt="asset.alt_text || '收藏图片'"
            loading="lazy"
          />
        </button>
        <video
          v-else-if="asset.mime?.startsWith('video/')"
          :src="assetURL(asset)"
          controls
          playsinline
          preload="none"
        >
          <a :href="assetURL(asset, false)">下载视频</a>
        </video>
        <a v-else class="download" :href="assetURL(asset, false)">下载文件</a>
        <figcaption v-if="asset.mime?.startsWith('video/')">
          <a :href="assetURL(asset, false)">无法播放？下载原文件</a>
        </figcaption></template
      >
    </figure>
  </div>
  <ImageViewer
    v-if="selected"
    :images="images"
    :initial-id="selected.id"
    @close="selected = undefined"
  />
</template>
<style scoped>
.media {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 4px;
  margin-top: 12px;
}
.item {
  margin: 0;
  min-width: 0;
}
.frame {
  display: block;
  width: 100%;
  background: none;
}
.media :deep(.image-shell img),
.media :deep(.image-shell),
.media video {
  display: block;
  width: 100%;
  max-height: 46dvh;
  object-fit: contain;
  border-radius: 8px;
  background: var(--fill);
}
.sensitive {
  position: relative;
  display: grid;
  place-items: center;
  width: 100%;
  min-height: 150px;
  overflow: hidden;
  isolation: isolate;
  border-radius: 8px;
  background: var(--fill);
  font-size: 14px;
}
.sensitive :deep(.blurred) {
  grid-area: 1 / 1;

  transform: scale(1.12);
  pointer-events: none;
}
.sensitive video.blurred,
.sensitive :deep(.blurred img) {
  filter: blur(18px);
}
.sensitive-label {
  z-index: 1;
  grid-area: 1 / 1;
  padding: 8px 12px;
  margin: 12px;
  border-radius: 20px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
}
.notice {
  margin: 0;
  padding: 14px;
  border-radius: 8px;
  background: var(--fill);
  color: var(--subtle);
  font-size: 14px;
}
.download {
  display: block;
  padding: 14px 0;
  font-size: 15px;
}
figcaption {
  padding: 6px 2px;
  font-size: 13px;
}
</style>
