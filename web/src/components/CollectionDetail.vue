<script setup vapor lang="ts">
import { computed } from "vue";
import { safeURL, type Collection } from "../api";
import { date } from "../presentation";
import { useCollectionDetail } from "../composables/useCollectionDetail";
import CollectionPost from "./CollectionPost.vue";
import RevisionList from "./RevisionList.vue";
import ConfirmSheet from "./ConfirmSheet.vue";
import ListSection from "./ui/ListSection.vue";
import ListButton from "./ui/ListButton.vue";
const props = defineProps<{
  id: string;
  savedAt?: string;
  showSensitive?: boolean;
}>();
const emit = defineEmits<{
  deleted: [id: string];
  updated: [collection: Collection];
}>();
const {
  collection,
  error,
  busy,
  status,
  revisions,
  next,
  showHistory,
  historical,
  confirmDelete,
  available,
  historyPage,
  revision,
  remove,
  refresh,
  checkAvailability,
} = useCollectionDetail(
  () => props.id,
  (id) => emit("deleted", id),
  (collection) => emit("updated", collection),
);
const saved = computed(() => date(props.savedAt || collection.value?.saved_at));
const link = computed(() => collection.value && safeURL(collection.value.url));
const version = computed(() =>
  collection.value
    ? `当前版本抓取于 ${date(collection.value.observed_at)}`
    : "",
);
</script>
<template>
  <ListSection v-if="error" plain>
    <p class="banner" role="alert">{{ error }}</p>
  </ListSection>
  <p v-if="!collection && !error" class="loading">正在打开收藏…</p>
  <template v-if="collection">
    <ListSection v-if="historical">
      <ListButton
        label="正在查看历史版本"
        hint="内容与媒体都来自这个版本"
        trailing="回到当前"
        :disabled="busy"
        @select="revision()"
      />
    </ListSection>
    <ListSection :footnote="saved ? `保存于 ${saved}` : undefined">
      <CollectionPost
        :collection="collection"
        :show-sensitive="showSensitive"
      />
    </ListSection>
    <ListSection :footnote="version">
      <ListButton v-if="link" label="打开原文" :href="link" />
      <ListButton
        label="重新抓取"
        :disabled="busy || !available"
        @select="refresh"
      />
      <ListButton
        v-if="!available"
        label="重试连接采集服务"
        @select="checkAvailability"
      />
      <ListButton
        label="历史版本"
        variant="plain"
        chevron
        @select="historyPage()"
      />
    </ListSection>
    <!-- Kept mounted so progress is announced as it changes. -->
    <p class="status" :class="{ quiet: !status }" role="status">{{ status }}</p>
    <RevisionList
      v-if="showHistory"
      :revisions="revisions"
      :next="next"
      :busy="busy"
      :current="!historical"
      @select="revision($event)"
      @more="historyPage(true)"
    />
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
