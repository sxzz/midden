<script setup vapor lang="ts">
import MediaPreview from './MediaPreview.vue'
import EyeIcon from './ui/EyeIcon.vue'
import type { Asset } from '../api'
export type AlbumTile = {
  key: string
  asset: Asset
  hidden: boolean
  caption?: {
    labels: string
    text: string
    quote: string
    quoteAuthor?: string
  }
}
defineProps<{ tiles: AlbumTile[]; loading?: boolean }>()
defineEmits<{ select: [key: string] }>()
const isVideo = (asset: Asset) => !!asset.mime?.startsWith('video/')
function label(tile: AlbumTile) {
  if (tile.hidden) return '敏感内容，点按显示'
  return isVideo(tile.asset) ? '播放视频' : '放大图片'
}
// The skeleton stands in for a full screen of tiles, not for the real count.
const placeholders = 12
</script>

<template>
  <div
    v-if="loading && !tiles.length"
    class="album"
    role="status"
    aria-label="正在加载收藏"
    aria-busy="true"
  >
    <span
      v-for="i in placeholders"
      :key="i"
      class="tile skeleton"
      aria-hidden="true"
    />
  </div>
  <div v-else class="album">
    <button
      v-for="tile in tiles"
      :key="tile.key"
      type="button"
      class="tile"
      :class="{ blurred: tile.hidden }"
      :data-key="tile.key"
      :aria-label="label(tile)"
      @click="$emit('select', tile.key)"
    >
      <span class="media">
        <MediaPreview :asset="tile.asset" thumbnail />
        <span v-if="isVideo(tile.asset)" class="play" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5.5v13l11-6.5z" />
          </svg>
        </span>
        <span v-if="tile.hidden" class="veil" aria-hidden="true"
          ><EyeIcon
        /></span>
      </span>
      <span
        v-if="tile.caption"
        class="caption"
        :title="
          [
            tile.caption.labels,
            tile.caption.text,
            [tile.caption.quoteAuthor, tile.caption.quote]
              .filter(Boolean)
              .join('：'),
          ]
            .filter(Boolean)
            .join(' · ')
        "
      >
        <span v-if="tile.caption.labels" class="relation-label">{{
          tile.caption.labels
        }}</span>
        <span class="caption-text">{{ tile.caption.text }}</span>
        <span v-if="tile.caption.quote" class="quote"
          ><span class="quote-label">引用的帖子</span
          ><span v-if="tile.caption.quoteAuthor" class="quote-author"
            >{{ tile.caption.quoteAuthor }}：</span
          >{{ tile.caption.quote }}</span
        >
      </span>
    </button>
  </div>
</template>

<style scoped>
/* A tight contact sheet: square tiles, hairline gaps, nothing but the media. */
.album {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
  gap: 2px;
}
.tile {
  position: relative;
  display: block;
  width: 100%;
  aspect-ratio: 1;
  text-align: left;
  overflow: hidden;
  background: var(--fill);
}
.tile.skeleton {
  aspect-ratio: 1;
  border-radius: 0;
}
.media {
  position: relative;
  display: block;
  aspect-ratio: 1;
  overflow: hidden;
}
.caption {
  position: absolute;
  inset: auto 0 0;
  display: grid;
  gap: 2px;
  padding: 14px 6px 5px;
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.8));
  color: white;
  font-size: 11px;
  line-height: 1.3;
  pointer-events: none;
}
.caption-text,
.quote {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 1;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.relation-label {
  font-weight: 600;
}
.quote {
  opacity: 0.9;
}
.quote-label {
  margin-right: 4px;
  font-weight: 600;
}
.quote-author {
  font-weight: 600;
}
.tile :deep(.image-shell),
.tile :deep(video) {
  width: 100%;
  height: 100%;
  min-height: 0;
  object-fit: cover;
}
.tile :deep(img) {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.tile:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: -3px;
  border-radius: 0;
}
.tile:active :deep(.image-shell),
.tile:active :deep(video) {
  transform: scale(0.97);
}
.tile :deep(.image-shell),
.tile :deep(video) {
  transition: transform 180ms cubic-bezier(0.32, 0.72, 0, 1);
}
.tile.blurred :deep(img),
.tile.blurred :deep(video) {
  filter: blur(16px);
  transform: scale(1.25);
}
/* Video tiles say so with a corner glyph, so the grid stays quiet. */
.play {
  position: absolute;
  right: 5px;
  bottom: 5px;
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  color: #fff;
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.6));
  pointer-events: none;
}
.play svg {
  width: 100%;
  height: 100%;
}
.veil {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.25);
  color: #fff;
  pointer-events: none;
}
@media (prefers-reduced-motion: reduce) {
  .tile:active :deep(.image-shell),
  .tile:active :deep(video) {
    transform: none;
  }
}
</style>
