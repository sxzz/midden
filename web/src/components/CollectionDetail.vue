<script setup vapor lang="ts">
import { computed, shallowRef, watch } from 'vue'
import { safeURL, type Collection, type UpdateMode } from '../api'
import { useCollectionDetail } from '../composables/useCollectionDetail'
import { date, present } from '../presentation'
import CollectionAnnotations from './CollectionAnnotations.vue'
import CollectionPost from './CollectionPost.vue'
import ConfirmSheet from './ConfirmSheet.vue'
import ProfileCollections from './ProfileCollections.vue'
import RevisionList from './RevisionList.vue'
import CollectionSkeleton from './ui/CollectionSkeleton.vue'
import ListButton from './ui/ListButton.vue'
import ListSection from './ui/ListSection.vue'
import UpdateModeSheet from './UpdateModeSheet.vue'
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
  membersVersion,
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
const isProfile = computed(() =>
  collection.value?.graph?.entities.some(
    (entity) =>
      entity.key === collection.value?.graph?.root &&
      entity.type === 'x.profile',
  ),
)
// The related list is this profile's own timeline, so the posts it holds by a
// repost relation were reposted by this profile and say so.
const profileName = computed(() =>
  collection.value ? present(collection.value).name : '',
)
const link = computed(() => collection.value && safeURL(collection.value.url))
const choosingMode = shallowRef(false)
function refreshWith(mode: UpdateMode) {
  choosingMode.value = false
  void refresh(mode)
}
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
        @select="choosingMode = true"
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
    <ProfileCollections
      v-if="isProfile"
      :id="id"
      :revision-id="latestRevision"
      :members-version="membersVersion"
      :show-sensitive="showSensitive"
      :reposted-by="profileName"
    />
    <UpdateModeSheet
      :open="choosingMode"
      title="重新抓取"
      @select="refreshWith"
      @cancel="choosingMode = false"
    />
    <ConfirmSheet
      :open="confirmDelete"
      title="删除这条收藏？"
      description="不影响其他用户保存的记录。"
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
