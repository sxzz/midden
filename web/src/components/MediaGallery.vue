<script setup vapor lang="ts">
import { shallowRef, useTemplateRef, nextTick, watch } from "vue";
import { assetURL, type Asset } from "../api";
import { mediaNotice } from "../presentation";
const props = defineProps<{ assets: Asset[]; showSensitive?: boolean }>();
const selected = shallowRef<Asset>();
const dialog = useTemplateRef<HTMLDialogElement>("viewer");
async function view(asset: Asset) {
  selected.value = asset;
  await nextTick();
  dialog.value?.showModal();
}
const revealed = shallowRef<string[]>([]);
watch(
  () => props.showSensitive,
  (show) => {
    if (!show) {
      revealed.value = [];
      if (selected.value?.sensitive) {
        dialog.value?.close();
        selected.value = undefined;
      }
    }
  },
);
function reveal(id: string) {
  revealed.value = [...revealed.value, id];
}
function backdrop(event: MouseEvent) {
  if (event.target === dialog.value) dialog.value?.close();
}
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
        <img
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
          <img
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
  <dialog ref="viewer" class="viewer" @click="backdrop">
    <div class="viewer-bar">
      <button type="button" class="close" @click="dialog?.close()">
        关闭图片
      </button>
    </div>
    <img
      v-if="selected"
      :src="assetURL(selected)"
      :alt="selected.alt_text || '收藏图片'"
    />
    <p v-if="selected?.alt_text" class="alt">{{ selected.alt_text }}</p>
  </dialog>
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
.media img,
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
.sensitive .blurred {
  grid-area: 1 / 1;
  filter: blur(18px);
  transform: scale(1.12);
  pointer-events: none;
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
.viewer {
  width: 100vw;
  max-width: 100vw;
  height: 100dvh;
  max-height: 100dvh;
  margin: 0;
  padding: 0;
  border: 0;
  background: #000;
  color: #fff;
  display: grid;
  grid-template-rows: auto 1fr auto;
  align-items: center;
}
.viewer:not([open]) {
  display: none;
}
.viewer::backdrop {
  background: #000;
}
.viewer-bar {
  padding: max(10px, env(safe-area-inset-top)) 14px 10px;
}
.close {
  min-height: 44px;
  font-size: 16px;
  color: #fff;
}
.viewer img {
  display: block;
  max-width: 100vw;
  max-height: 100%;
  margin: auto;
  object-fit: contain;
}
.alt {
  margin: 0;
  padding: 12px 16px max(12px, env(safe-area-inset-bottom));
  font-size: 13px;
  line-height: 1.5;
  color: #d5d5d5;
}
</style>
