<script setup vapor lang="ts">
import { computed, onDeactivated, shallowRef, watch } from 'vue'
import AlbumGrid from './AlbumGrid.vue'
import MediaViewer from './MediaViewer.vue'
import type { Asset, Collection } from '../api'
const props = defineProps<{
  items: Collection[]
  mediaTypes: string
  showSensitive?: boolean
  loading: boolean
  next: string
  error: string
}>()
const emit = defineEmits<{ open: [id: string] }>()
const entries = computed(() =>
  props.items.flatMap((collection) =>
    (collection.assets || [])
      .filter(
        (asset) =>
          asset.state === 'ready' &&
          !asset.purpose &&
          (asset.mime?.startsWith('image/') ||
            asset.mime?.startsWith('video/')) &&
          (!props.mediaTypes ||
            props.mediaTypes.split(',').includes(asset.mime!.split('/')[0]!)),
      )
      .map((asset) => ({
        key: `${collection.id}:${asset.id}`,
        asset,
        collectionId: collection.id,
      })),
  ),
)
const revealed = shallowRef<string[]>([])
const tiles = computed(() =>
  entries.value.map((entry) => ({
    ...entry,
    hidden:
      !!entry.asset.sensitive &&
      !props.showSensitive &&
      !revealed.value.includes(entry.key),
  })),
)
// Snapshot the preview session so fetching another page doesn't interrupt it.
const preview = shallowRef<{
  assets: Asset[]
  collectionIds: Record<string, string>
  initialId: string
}>()
function select(key: string) {
  const tile = tiles.value.find((entry) => entry.key === key)
  if (!tile) return
  if (tile.hidden) {
    const group = entries.value.filter(
      (entry) => entry.collectionId === tile.collectionId,
    )
    const keys = group.every((entry) => entry.asset.sensitive)
      ? group.map((entry) => entry.key)
      : [key]
    revealed.value = [...new Set([...revealed.value, ...keys])]
    return
  }
  preview.value = {
    assets: entries.value.map((entry) => entry.asset),
    collectionIds: Object.fromEntries(
      entries.value.map((entry) => [entry.asset.id, entry.collectionId]),
    ),
    initialId: tile.asset.id,
  }
}
function open(id: string) {
  preview.value = undefined
  emit('open', id)
}
watch(
  () => props.showSensitive,
  () => {
    revealed.value = []
    preview.value = undefined
  },
)
watch(entries, (items) => {
  const available = new Set(items.map((item) => item.key))
  revealed.value = revealed.value.filter((key) => available.has(key))
  if (!items.length) preview.value = undefined
})
onDeactivated(() => {
  preview.value = undefined
})
</script>

<template>
  <AlbumGrid :tiles="tiles" :loading="loading" @select="select" />
  <p v-if="!tiles.length && !loading && !next && !error" class="empty">
    暂无匹配的图片或视频
  </p>
  <MediaViewer
    v-if="preview"
    :assets="preview.assets"
    :initial-id="preview.initialId"
    :collection-ids="preview.collectionIds"
    @close="preview = undefined"
    @open="open"
  />
</template>

<style scoped>
.empty {
  margin: 0;
  padding: 48px 32px;
  text-align: center;
  font-size: 15px;
  line-height: 1.7;
  color: var(--subtle);
}
</style>
