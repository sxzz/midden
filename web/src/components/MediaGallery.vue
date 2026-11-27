<script setup vapor lang="ts">
import { computed, shallowRef, watch } from 'vue'
import { assetURL, safeURL, type Asset, type Collection } from '../api'
import { useSensitiveMedia } from '../composables/useSensitiveMedia'
import {
  layoutMedia,
  ratioOf,
  REMOVED_MAX_RATIO,
  REMOVED_MIN_RATIO,
  track,
  type LayoutItem,
} from '../media-layout'
import {
  isRemoved,
  isRestoring,
  mediaNotice,
  removedLabel,
  restoreLabel,
} from '../presentation'
import MediaPreview from './MediaPreview.vue'
import MediaViewer from './MediaViewer.vue'
import EyeIcon from './ui/EyeIcon.vue'
import LoadingImage from './ui/LoadingImage.vue'
const props = defineProps<{
  assets: Asset[]
  showSensitive?: boolean
  collection?: Collection
  /** The owner's page: removed media can be restored. */
  editable?: boolean
}>()
const emit = defineEmits<{ restore: [asset: Asset] }>()
// Removed media has no copy here: the post's own page on the platform.
const source = computed(() => props.collection && safeURL(props.collection.url))
const selected = shallowRef<Asset>()
function view(asset: Asset) {
  selected.value = asset
}
const { covered, hidden, reveal, revealAll } = useSensitiveMedia(
  () => props.assets,
  () => props.showSensitive,
)
const isMedia = (asset: Asset) =>
  !!asset.mime?.startsWith('image/') || !!asset.mime?.startsWith('video/')
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
interface Slot extends LayoutItem {
  asset: Asset
}
// The box is reserved from the stored size, so nothing moves as media loads.
const rows = computed(() =>
  layoutMedia(
    props.assets.map((asset): Slot => {
      // Restoring media is shown as removed media is, by its thumbnail.
      const removed = isRemoved(asset) || isRestoring(asset)
      const ratio = ratioOf(asset) ?? measured.value[asset.id]
      return {
        asset,
        box: removed || (asset.state === 'ready' && isMedia(asset)),
        // The label of removed media needs room.
        ratio:
          removed && ratio
            ? Math.min(Math.max(ratio, REMOVED_MIN_RATIO), REMOVED_MAX_RATIO)
            : ratio,
      }
    }),
  ),
)
// The group is as wide as its widest row, so the veil over it covers the
// media and not the empty width beside a narrowed box.
const groupRatio = computed(() =>
  Math.max(0, ...rows.value.map((row) => row.ratio ?? 0)),
)
// Opening the viewer is itself the decision to look, so it carries the whole
// group: paging from an uncovered image must not dead-end on a missing one.
const previews = computed(() =>
  props.assets.filter(
    (asset) =>
      asset.state === 'ready' &&
      (asset.mime?.startsWith('image/') || asset.mime?.startsWith('video/')),
  ),
)
watch(
  () => props.showSensitive,
  (show) => {
    if (!show && selected.value?.sensitive) selected.value = undefined
  },
)
watch(
  () => props.assets,
  () => {
    selected.value = undefined
  },
)
</script>

<template>
  <div
    v-if="assets.length"
    class="media-group"
    :class="{ sized: groupRatio }"
    :style="groupRatio ? { '--group-ratio': groupRatio } : undefined"
  >
    <!-- While one veil covers the group, nothing beneath it may be tabbed to. -->
    <div
      class="media"
      :class="{ many: assets.length > 4 }"
      :inert="covered || undefined"
      @load.capture="measure"
      @loadedmetadata.capture="measure"
    >
      <div
        v-for="row in rows"
        :key="row.cells[0]!.item.asset.id"
        class="row"
        :class="{ boxed: row.ratio }"
        :style="
          row.ratio
            ? {
                '--row-ratio': row.ratio,
                gridTemplateColumns: row.cells
                  .map((cell) => track(cell.flex))
                  .join(' '),
              }
            : undefined
        "
      >
        <figure
          v-for="{ item, flex } in row.cells"
          :key="item.asset.id"
          class="item"
          :class="{ boxed: row.ratio }"
          :style="row.ratio ? { '--cell-ratio': flex } : undefined"
          :data-asset="item.asset.id"
        >
          <div
            v-if="isRemoved(item.asset) || isRestoring(item.asset)"
            class="frame removed"
            :class="{ blurred: hidden(item.asset) }"
          >
            <LoadingImage
              v-if="item.asset.thumbnail_url"
              :src="item.asset.thumbnail_url"
              :alt="item.asset.alt_text || ''"
            />
            <span v-if="isRestoring(item.asset)" class="removed-label">
              <span role="status">下载中</span>
            </span>
            <span v-else class="removed-label">
              <a
                v-if="source"
                :href="source"
                target="_blank"
                rel="noopener noreferrer"
                >{{ removedLabel(item.asset) }} · 在原站查看 ›</a
              ><span v-else>{{ removedLabel(item.asset) }}</span>
              <template v-if="editable">
                <small v-if="item.asset.restore_error"
                  >无法重新下载：{{ item.asset.restore_error }}</small
                >
                <button
                  type="button"
                  class="restore"
                  @click="emit('restore', item.asset)"
                >
                  {{ restoreLabel(item.asset) }}
                </button>
              </template>
            </span>
          </div>
          <p v-else-if="item.asset.state !== 'ready'" class="notice">
            {{ mediaNotice(item.asset) }}
          </p>
          <button
            v-else-if="isMedia(item.asset)"
            type="button"
            class="frame"
            :class="{ sensitive: hidden(item.asset) }"
            :aria-label="
              hidden(item.asset) && !covered
                ? '敏感内容，点按显示'
                : item.asset.mime?.startsWith('video/')
                  ? '播放视频'
                  : '放大图片'
            "
            @click="
              hidden(item.asset) ? reveal(item.asset.id) : view(item.asset)
            "
          >
            <MediaPreview
              :asset="item.asset"
              fit="contain"
              eager
              :alt="item.asset.alt_text"
              :class="{ blurred: hidden(item.asset) }"
            />
            <span v-if="hidden(item.asset) && !covered" class="sensitive-label"
              ><EyeIcon
            /></span>
            <span
              v-else-if="
                !hidden(item.asset) && item.asset.mime?.startsWith('video/')
              "
              class="play"
              aria-hidden="true"
              >▶</span
            >
          </button>
          <a v-else class="download" :href="assetURL(item.asset, false)"
            >下载文件</a
          >
        </figure>
      </div>
    </div>
    <button
      v-if="covered"
      type="button"
      class="group-veil"
      aria-label="敏感内容，点按显示"
      @click.stop="revealAll"
    >
      <EyeIcon />
    </button>
  </div>
  <MediaViewer
    v-if="selected"
    :assets="previews"
    :initial-id="selected.id"
    :collection="collection"
    :collection-id="collection?.id"
    @close="selected = undefined"
  />
</template>

<style scoped>
.media-group {
  /* A row is as tall as its media's shape makes it, and no taller than the
     tallest single box would be: a tall one is narrowed to keep its shape. */
  --media-max-height: min(480px, 70vh);
  position: relative;
  margin-top: 12px;
  max-width: 640px;
}
.media-group.sized {
  width: min(100%, calc(var(--media-max-height) * var(--group-ratio)));
}
.media {
  display: grid;
  gap: 4px;
}
/* Past four items the group scrolls instead of running down the page. */
.media.many {
  max-height: var(--media-max-height);
  overflow-y: auto;
}
.row {
  display: grid;
  gap: 4px;
}
.row.boxed {
  width: min(100%, calc(var(--media-max-height) * var(--row-ratio)));
}
/* One veil for the whole group, sized to it, so the label has room to read. */
.group-veil {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  width: 100%;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.35);
  color: #fff;
  font-size: 14px;
}
.group-veil:focus-visible {
  outline: 2px solid #fff;
  outline-offset: -4px;
}
.item {
  margin: 0;
  min-width: 0;
  min-height: 0;
}
/* Each cell is the shape its width share is, so a row of two has no gap's
   worth of bars. */
.item.boxed {
  aspect-ratio: var(--cell-ratio);
}
.frame {
  position: relative;
  display: block;
  width: 100%;
  height: 100%;
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
/* The kept thumbnail, dimmed under what became of the media. */
.removed {
  display: grid;
  place-items: center;
}
.removed :deep(.image-shell) {
  position: absolute;
  inset: 0;
  min-height: 0;
}
.removed :deep(img) {
  width: 100%;
  height: 100%;
  object-fit: cover;
  opacity: 0.45;
}
.removed.blurred :deep(img) {
  filter: blur(18px);
}
.removed-label {
  position: relative;
  display: grid;
  gap: 6px;
  justify-items: center;
  padding: 8px 12px;
  border-radius: 12px;
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  font-size: 13px;
  text-align: center;
}
.removed-label a {
  color: inherit;
  text-decoration: none;
}
.restore {
  padding: 2px 8px;
  color: #fff;
  font-size: 13px;
  font-weight: 600;
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
