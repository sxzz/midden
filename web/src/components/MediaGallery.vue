<script setup vapor lang="ts">
import { computed, shallowRef, watch } from 'vue'
import { assetURL, type Asset } from '../api'
import { useSensitiveMedia } from '../composables/useSensitiveMedia'
import { mediaNotice } from '../presentation'
import MediaPreview from './MediaPreview.vue'
import MediaViewer from './MediaViewer.vue'
import EyeIcon from './ui/EyeIcon.vue'
const props = defineProps<{ assets: Asset[]; showSensitive?: boolean }>()
const selected = shallowRef<Asset>()
function view(asset: Asset) {
  selected.value = asset
}
const { covered, hidden, reveal, revealAll } = useSensitiveMedia(
  () => props.assets,
  () => props.showSensitive,
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
  <div v-if="assets.length" class="media-group">
    <!-- While one veil covers the group, nothing beneath it may be tabbed to. -->
    <div class="media" :inert="covered || undefined">
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
            hidden(asset) && !covered
              ? '敏感内容，点按显示'
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
          <span v-if="hidden(asset) && !covered" class="sensitive-label"
            ><EyeIcon
          /></span>
          <span
            v-else-if="!hidden(asset) && asset.mime?.startsWith('video/')"
            class="play"
            aria-hidden="true"
            >▶</span
          >
        </button>
        <a v-else class="download" :href="assetURL(asset, false)">下载文件</a>
      </figure>
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
    @close="selected = undefined"
  />
</template>

<style scoped>
.media-group {
  position: relative;
  margin-top: 12px;
}
.media {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px;
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
.media:has(.item:only-child) {
  grid-template-columns: 1fr;
}
.item:only-child .frame {
  aspect-ratio: auto;
  --media-height: auto;
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
