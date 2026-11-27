<script setup vapor lang="ts">
import { computed, onDeactivated, shallowRef, watch } from 'vue'
import { excerpt, present } from '../presentation'
import {
  authoredBy,
  authorIdentity,
  authorLabel,
  isPostEntity,
} from '../relations'
import AlbumGrid from './AlbumGrid.vue'
import MediaViewer from './MediaViewer.vue'
import type { Collection } from '../api'
const props = defineProps<{
  items: Collection[]
  mediaTypes: string
  showSensitive?: boolean
  loading: boolean
  next: string
  error: string
}>()
const emit = defineEmits<{ more: [] }>()
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
      .map((asset, index) => ({
        key: `${collection.id}:${asset.id}`,
        asset,
        collectionId: collection.id,
        caption: index === 0 ? caption(collection) : undefined,
      })),
  ),
)
function caption(collection: Collection) {
  const graph = collection.graph
  const quoted =
    graph?.relations.flatMap((relation) => {
      if (relation.source !== graph.root || relation.type !== 'quoted')
        return []
      const target = graph.entities.find(
        (entity) => entity.key === relation.target && isPostEntity(entity),
      )
      if (!target) return []
      // A quoted post is kept by reference; its saved collection says what
      // it is.
      const own =
        typeof target.data.text === 'string' && target.data.text.trim()
          ? excerpt(target.data.text, 100)
          : target.saved_text
            ? excerpt(target.saved_text, 100)
            : target.saved_summary
              ? excerpt(target.saved_summary, 100)
              : ''
      const author = authorIdentity(authoredBy(graph, target.key))
      return [
        {
          text: own || '查看引用的帖子',
          lang: own ? target.saved_lang : undefined,
          // A tile is a button, so attribution stays plain text here.
          author: authorLabel(author),
          authorLang: author?.lang,
        },
      ]
    }) ?? []
  const labels = [
    collection.relation_types?.includes('reposted') && '转发',
    collection.relation_types?.includes('mentions') && '提及',
  ]
    .filter(Boolean)
    .join(' · ')
  const view = present(collection)
  const single = quoted.length === 1 ? quoted[0] : undefined
  return {
    labels,
    text: excerpt(view.body, 80),
    lang: view.lang,
    quote: quoted.map((entry) => entry.text).join('；'),
    quoteLang: single?.lang,
    // Attribution only stays unambiguous while there is a single quote.
    quoteAuthor: single?.author ?? '',
    quoteAuthorLang: single?.authorLang,
  }
}
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
// The viewer follows the album: a page fetched while it is open adds to its
// items, and it asks for the next one near their end.
const preview = shallowRef<{ initialId: string }>()
const previewAssets = computed(() => entries.value.map((entry) => entry.asset))
const previewCollections = computed(() =>
  Object.fromEntries(
    entries.value.map((entry) => [entry.asset.id, entry.collectionId]),
  ),
)
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
  preview.value = { initialId: tile.asset.id }
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
  <MediaViewer
    v-if="preview"
    :assets="previewAssets"
    :initial-id="preview?.initialId || ''"
    :collection-ids="previewCollections"
    :collections="items"
    :more="!!next"
    :loading-more="loading"
    @more="emit('more')"
    @close="preview = undefined"
  />
</template>

<style scoped></style>
