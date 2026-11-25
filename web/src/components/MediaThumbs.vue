<script setup vapor lang="ts">
import { computed, shallowRef, watch } from 'vue'
import { useSensitiveMedia } from '../composables/useSensitiveMedia'
import { layoutMedia, ratioOf } from '../media-layout'
import { isRemoved, readyMedia, removedLabel } from '../presentation'
import { collectionHref } from '../share'
import { detailTitles, kindOf } from '../titles'
import MediaPreview from './MediaPreview.vue'
import MediaViewer from './MediaViewer.vue'
import AppLink from './ui/AppLink.vue'
import EyeIcon from './ui/EyeIcon.vue'
import LoadingImage from './ui/LoadingImage.vue'
import type { Asset, Collection } from '../api'
const props = defineProps<{
  size?: 'small' | 'medium' | 'large'
  desktopSize?: 'small' | 'medium' | 'large'
  assets: Asset[]
  collection?: Collection
  showSensitive?: boolean
  collectionId?: string
}>()
const selected = shallowRef<Asset>()
// Shapes read from the media once it loads, for what the server has no size.
const measured = shallowRef<Record<string, number>>({})
function measure(event: Event) {
  const target = event.target
  const id =
    target instanceof Element
      ? target.closest<HTMLElement>('[data-asset]')?.dataset.asset
      : undefined
  const ratio =
    target instanceof HTMLImageElement
      ? ratioOf({ width: target.naturalWidth, height: target.naturalHeight })
      : target instanceof HTMLVideoElement
        ? ratioOf({ width: target.videoWidth, height: target.videoHeight })
        : undefined
  if (id && ratio && measured.value[id] !== ratio)
    measured.value = { ...measured.value, [id]: ratio }
}
const LIMIT = 4
// Removed media still shows, by the thumbnail its removal kept.
const media = computed(() =>
  props.assets.filter(
    (asset) =>
      asset.state === 'ready' || (isRemoved(asset) && !!asset.thumbnail_url),
  ),
)
// Whether the group is uniformly sensitive is a property of the whole row, not
// of the four tiles that happen to fit.
const { covered, hidden, reveal, revealAll } = useSensitiveMedia(
  media,
  () => props.showSensitive,
)
// Opening the viewer is itself the decision to look, so it carries the whole
// group: paging from an uncovered image must not dead-end on a missing one.
const previews = computed(() =>
  readyMedia(media.value).filter(
    (asset) =>
      asset.mime?.startsWith('image/') || asset.mime?.startsWith('video/'),
  ),
)
const viewable = (asset: Asset) =>
  !isRemoved(asset) &&
  (!!asset.mime?.startsWith('image/') || !!asset.mime?.startsWith('video/'))
/** What the tiles' link opens, named as that page is. */
const detailLabel = computed(
  () =>
    `查看${detailTitles[(props.collectionId && kindOf(props.collectionId, props.collection)) || 'post']}`,
)
/** A removed media item or a file has nothing to view: it links to its post. */
const tileLink = (asset: Asset) =>
  props.collectionId && !viewable(asset)
    ? collectionHref(props.collectionId)
    : undefined
function view(asset: Asset) {
  if (!viewable(asset)) return
  // Uncovering and looking are two taps, here as in the detail gallery.
  if (hidden(asset)) reveal(asset.id)
  else selected.value = asset
}
watch(
  () => [props.assets, props.showSensitive],
  () => {
    selected.value = undefined
  },
)
const tiles = computed(() => media.value.slice(0, LIMIT))
/**
 * One or two tiles take the media's own shape (see `layoutMedia`), so a wide
 * screenshot is not letterboxed in a square. More keep the fixed grid.
 */
const shape = computed(() => {
  if (tiles.value.length > 2) return
  const rows = layoutMedia(
    tiles.value.map((asset) => ({
      asset,
      ratio: ratioOf(asset) ?? measured.value[asset.id],
    })),
  )
  const ratios = rows.map((row) => row.ratio!)
  return {
    // Stacked rows are as tall as their widths make them, one above the other.
    ratio:
      rows.length === 1
        ? ratios[0]!
        : 1 / ratios.reduce((n, r) => n + 1 / r, 0),
    columns: rows[0]!.cells
      .map((cell) => `minmax(0, ${cell.flex}fr)`)
      .join(' '),
    // Proportional to height; fr values summing under 1 would not fill the box.
    rows: rows.map((row) => `minmax(0, ${1000 / row.ratio!}fr)`).join(' '),
  }
})
const overflow = computed(() => media.value.length - tiles.value.length)
</script>

<template>
  <span
    v-if="tiles.length"
    class="thumbs-group"
    :class="[
      `size-${size || 'small'}`,
      `desktop-${desktopSize || 'medium'}`,
      `count-${tiles.length}`,
    ]"
    :style="{ '--preview-ratio': shape?.ratio ?? 2 }"
    @load.capture="measure"
    @loadedmetadata.capture="measure"
  >
    <!-- While one veil covers the group, nothing beneath it may be tabbed to. -->
    <span
      class="thumbs"
      :class="{ shaped: shape }"
      :style="
        shape
          ? { gridTemplateColumns: shape.columns, gridTemplateRows: shape.rows }
          : undefined
      "
      :inert="covered || undefined"
    >
      <component
        :is="tileLink(asset) ? AppLink : 'button'"
        v-for="(asset, index) in tiles"
        :key="asset.id"
        :type="tileLink(asset) ? undefined : 'button'"
        :href="tileLink(asset)"
        class="tile"
        :aria-label="
          isRemoved(asset)
            ? `${removedLabel(asset)}，${detailLabel}`
            : asset.mime?.startsWith('image/')
              ? hidden(asset) && !covered
                ? '敏感内容，点按显示'
                : '放大图片'
              : asset.mime?.startsWith('video/')
                ? hidden(asset) && !covered
                  ? '敏感内容，点按显示'
                  : '播放视频'
                : detailLabel
        "
        :class="{ blurred: hidden(asset) }"
        :data-asset="asset.id"
        @click.stop="view(asset)"
      >
        <template v-if="isRemoved(asset)">
          <LoadingImage :src="asset.thumbnail_url!" alt="" />
          <span class="removed">已移除</span>
        </template>
        <MediaPreview
          v-else-if="
            asset.mime?.startsWith('image/') || asset.mime?.startsWith('video/')
          "
          :asset="asset"
          thumbnail
          fit="contain"
        />
        <span v-else class="veil">文件</span>
        <span
          v-if="asset.mime?.startsWith('video/')"
          class="play"
          aria-hidden="true"
          >▶</span
        >
        <span v-if="hidden(asset) && !covered" class="sensitive-label"
          ><EyeIcon
        /></span>
        <span v-if="overflow && index === tiles.length - 1" class="more"
          >+{{ overflow }}</span
        >
      </component>
    </span>
    <button
      v-if="covered"
      type="button"
      class="group-veil"
      aria-label="敏感内容，点按显示"
      @click.stop="revealAll"
    >
      <EyeIcon />
    </button>
  </span>
  <MediaViewer
    v-if="selected"
    :assets="previews"
    :initial-id="selected.id"
    :collection-id="collectionId"
    :collection="collection"
    @close="selected = undefined"
  />
</template>

<style scoped>
.size-small {
  --attachment-height: 120px;
}
.size-medium {
  --attachment-height: 180px;
}
.size-large {
  --attachment-height: 260px;
}
@media (min-width: 768px) {
  .desktop-small {
    --attachment-height: 120px;
  }
  .desktop-medium {
    --attachment-height: 180px;
  }
  .desktop-large {
    --attachment-height: 260px;
  }
}
.thumbs-group {
  position: relative;
  display: flex;
  width: min(100%, calc(var(--attachment-height) * var(--preview-ratio)));
  max-width: 100%;
  margin-top: 8px;
}
.thumbs {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  width: 100%;
  min-width: 0;
  height: var(--attachment-height);
  grid-auto-rows: minmax(0, 1fr);
  gap: 4px;
}
/* One veil across the strip, so a uniformly sensitive row asks once. */
.group-veil {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 4px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.35);
  color: #fff;
  font-size: 11px;
  line-height: 1.3;
  text-align: center;
}
.group-veil:focus-visible {
  outline: 2px solid #fff;
  outline-offset: -3px;
}
.thumbs.shaped {
  /* Not stretched to the group: the height comes from the ratio. */
  align-self: flex-start;
  height: auto;
  aspect-ratio: var(--preview-ratio);
}
.count-3 .thumbs {
  grid-template-rows: repeat(2, minmax(0, 1fr));
}
.count-3 .tile:first-child {
  grid-row: span 2;
}
.tile {
  position: relative;
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  min-height: 0;
  flex-shrink: 0;
  border-radius: 8px;
  overflow: hidden;
  background: var(--fill);
}
.tile :deep(.image-shell),
.tile :deep(video) {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.tile :deep(.image-shell) {
  min-height: 0;
}
.tile.blurred :deep(img),
.tile.blurred :deep(video) {
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
.removed {
  position: absolute;
  right: 4px;
  bottom: 4px;
  padding: 1px 6px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  font-size: 11px;
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
