<script setup vapor lang="ts">
import { computed, shallowRef, watch } from 'vue'
import { safeURL, type Collection } from '../api'
import { useCollectionDetail } from '../composables/useCollectionDetail'
import { date } from '../presentation'
import CollectionAnnotations from './CollectionAnnotations.vue'
import CollectionPost from './CollectionPost.vue'
import ConfirmSheet from './ConfirmSheet.vue'
import RevisionList from './RevisionList.vue'
import CollectionSkeleton from './ui/CollectionSkeleton.vue'
import ListButton from './ui/ListButton.vue'
import ListSection from './ui/ListSection.vue'
const props = defineProps<{
  id: string
  savedAt?: string
  showSensitive?: boolean
}>()
const emit = defineEmits<{
  deleted: [id: string]
  updated: [collection: Collection]
  annotationsSaved: []
}>()
const {
  collection,
  error,
  busy,
  status,
  revisions,
  next,
  showHistory,
  historical,
  latestRevision,
  noHistory,
  historyLoading,
  loadingRevision,
  toggleHistory,
  confirmDelete,
  available,
  historyPage,
  revision,
  remove,
  refresh,
  checkAvailability,
} = useCollectionDetail(
  () => props.id,
  (id) => emit('deleted', id),
  (collection) => emit('updated', collection),
)
// A historical revision does not carry the collection's own save date, so keep
// the last one we learned and hand it to the post.
const savedAt = shallowRef(props.savedAt)
watch(
  () => props.savedAt || collection.value?.saved_at,
  (value) => {
    if (value) savedAt.value = value
  },
  { immediate: true },
)
const link = computed(() => collection.value && safeURL(collection.value.url))
const version = computed(() =>
  collection.value
    ? `${historical.value ? '历史' : '最新'}版本抓取于 ${date(collection.value.observed_at)}`
    : '',
)
</script>

<template>
  <ListSection v-if="error" plain>
    <p class="banner" role="alert">{{ error }}</p>
  </ListSection>
  <ListSection v-if="!collection && !error"
    ><CollectionSkeleton detail
  /></ListSection>
  <template v-if="collection">
    <ListSection>
      <CollectionSkeleton v-if="loadingRevision" detail />
      <CollectionPost
        v-else
        :collection="collection"
        :saved-at="savedAt"
        :show-sensitive="showSensitive"
      />
    </ListSection>
    <CollectionAnnotations
      :id="id"
      :key="id"
      @saved="emit('annotationsSaved')"
    />
    <ListSection :footnote="version">
      <ListButton v-if="link" label="打开原文" :href="link" />
      <ListButton
        label="重新抓取"
        :disabled="busy || loadingRevision || !available"
        @select="refresh"
      />
      <ListButton
        v-if="!available"
        label="重试连接采集服务"
        @select="checkAvailability"
      />
      <ListButton
        :label="noHistory ? '无历史版本' : '历史版本'"
        :trailing="noHistory ? undefined : showHistory ? '收起' : '展开'"
        :disabled="noHistory"
        :aria-expanded="showHistory && !noHistory"
        aria-controls="revision-options"
        @select="toggleHistory"
      />
      <RevisionList
        v-if="showHistory && !noHistory"
        id="revision-options"
        :revisions="revisions"
        :next="next"
        :busy="busy || loadingRevision"
        :loading="historyLoading"
        :selected-id="collection.revision_id"
        :latest-id="latestRevision"
        @select="revision($event)"
        @more="historyPage(true)"
      />
    </ListSection>
    <p class="status" :class="{ quiet: !status }" role="status">{{ status }}</p>
    <ListSection>
      <ListButton
        label="删除这条收藏"
        variant="destructive"
        :disabled="busy"
        @select="confirmDelete = true"
      />
    </ListSection>
    <ConfirmSheet
      :open="confirmDelete"
      title="删除这条收藏？"
      description="它会从你的收藏库移除，别人保存的记录不受影响。"
      confirm-label="删除"
      :busy="busy"
      @confirm="remove"
      @cancel="confirmDelete = false"
    />
  </template>
</template>

<style scoped>
.banner {
  margin: 0;
  padding: 14px var(--inset);
  border-radius: var(--radius);
  background: var(--card);
  font-size: 15px;
  line-height: 1.5;
}
.loading,
.status {
  margin: 0 0 16px;
  padding: 0 calc(var(--gutter) + 4px);
  font-size: 13px;
  line-height: 1.5;
  color: var(--subtle);
}
.loading {
  padding-top: 32px;
  text-align: center;
}
.status.quiet {
  margin: 0;
}
</style>
