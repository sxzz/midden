<script setup vapor lang="ts">
import { computed } from "vue";
import { assetURL, type Asset } from "../api";
import { readyMedia } from "../presentation";
const props = defineProps<{ assets: Asset[]; showSensitive?: boolean }>();
const LIMIT = 4;
const media = computed(() => readyMedia(props.assets));
const tiles = computed(() => media.value.slice(0, LIMIT));
const overflow = computed(() => media.value.length - tiles.value.length);
</script>
<template>
  <span v-if="tiles.length" class="thumbs" aria-hidden="true">
    <span
      v-for="(asset, index) in tiles"
      :key="asset.id"
      class="tile"
      :class="{ blurred: asset.sensitive && !showSensitive }"
    >
      <img
        v-if="asset.mime?.startsWith('image/')"
        :src="assetURL(asset)"
        alt=""
        loading="lazy"
        decoding="async"
      />
      <video
        v-else-if="asset.mime?.startsWith('video/')"
        :src="assetURL(asset) + '#t=0.1'"
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
    </span>
  </span>
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
.tile img,
.tile video {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.tile.blurred img,
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
