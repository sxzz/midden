<script setup vapor lang="ts">
import { computed, shallowRef, watch } from 'vue'
import { useSensitiveMedia } from '../composables/useSensitiveMedia'
import { readyMedia } from '../presentation'
import MediaPreview from './MediaPreview.vue'
import MediaViewer from './MediaViewer.vue'
import EyeIcon from './ui/EyeIcon.vue'
import type { Asset } from '../api'
const props = defineProps<{
  assets: Asset[]
  showSensitive?: boolean
  collectionId?: string
}>()
const emit = defineEmits<{ open: [] }>()
const selected = shallowRef<Asset>()
const LIMIT = 4
const media = computed(() => readyMedia(props.assets))
// Whether the group is uniformly sensitive is a property of the whole row, not
// of the four tiles that happen to fit.
const { covered, hidden, reveal, revealAll } = useSensitiveMedia(
  media,
  () => props.showSensitive,
)
// Opening the viewer is itself the decision to look, so it carries the whole
// group: paging from an uncovered image must not dead-end on a missing one.
const previews = computed(() =>
  media.value.filter(
    (asset) =>
      asset.mime?.startsWith('image/') || asset.mime?.startsWith('video/'),
  ),
)
function openCollection() {
  selected.value = undefined
  emit('open')
}
function view(asset: Asset) {
  if (!asset.mime?.startsWith('image/') && !asset.mime?.startsWith('video/')) {
    emit('open')
    return
  }
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
const overflow = computed(() => media.value.length - tiles.value.length)
</script>

<template>
  <span v-if="tiles.length" class="thumbs-group">
    <!-- While one veil covers the group, nothing beneath it may be tabbed to. -->
    <span class="thumbs" :inert="covered || undefined">
      <button
        v-for="(asset, index) in tiles"
        :key="asset.id"
        type="button"
        class="tile"
        :aria-label="
          asset.mime?.startsWith('image/')
            ? hidden(asset) && !covered
              ? '敏感内容，点按显示'
              : '放大图片'
            : asset.mime?.startsWith('video/')
              ? hidden(asset) && !covered
                ? '敏感内容，点按显示'
                : '播放视频'
              : '查看收藏详情'
        "
        :class="{ blurred: hidden(asset) }"
        @click.stop="view(asset)"
      >
        <MediaPreview
          v-if="
            asset.mime?.startsWith('image/') || asset.mime?.startsWith('video/')
          "
          :asset="asset"
          thumbnail
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
      </button>
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
    @open="openCollection"
    @close="selected = undefined"
  />
</template>

<style scoped>
.thumbs-group {
  position: relative;
  display: flex;
  width: max-content;
  max-width: 100%;
  margin-top: 8px;
}
.thumbs {
  display: flex;
  min-width: 0;
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
.tile :deep(video) {
  width: 100%;
  height: 100%;
  object-fit: cover;
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
