<script setup vapor lang="ts">
import { computed } from "vue";
import type { Archive, Usage } from "../api";
import { groupArchives } from "../presentation";
import ArchiveFilters from "./ArchiveFilters.vue";
import ArchiveRow from "./ArchiveRow.vue";
import ListSection from "./ui/ListSection.vue";
import ListButton from "./ui/ListButton.vue";
const props = defineProps<{
  items: Archive[];
  query: string;
  loading: boolean;
  error: string;
  next: string;
  usage?: Usage;
}>();
defineEmits<{
  search: [query: string];
  open: [id: string];
  more: [];
  retry: [];
}>();
const groups = computed(() => groupArchives(props.items));
const empty = computed(
  () => !props.loading && !props.error && !props.items.length,
);
const size = (n: number) =>
  n >= 1073741824
    ? (n / 1073741824).toFixed(1) + " GB"
    : (n / 1048576).toFixed(0) + " MB";
const storage = computed(() =>
  props.usage
    ? `已用 ${size(props.usage.used_bytes)}，共 ${size(props.usage.limit_bytes)}` +
      (props.usage.reserved_bytes
        ? `，${size(props.usage.reserved_bytes)} 正在保存`
        : "")
    : "",
);
</script>
<template>
  <ArchiveFilters
    :key="query"
    :query="query"
    @search="$emit('search', $event)"
  />
  <ListSection v-if="error">
    <p class="banner" role="alert">{{ error }}</p>
    <ListButton label="重试" @select="$emit('retry')" />
  </ListSection>
  <ListSection v-for="group in groups" :key="group.label" :title="group.label">
    <ArchiveRow
      v-for="a in group.items"
      :key="a.id"
      :archive="a"
      @open="$emit('open', $event)"
    />
  </ListSection>
  <p v-if="empty" class="empty">
    {{
      query
        ? "没有匹配的收藏。换个关键词，或清除筛选。"
        : "这里还是空的。在对话里把链接发给机器人，就会保存到这里。"
    }}
  </p>
  <ListSection v-if="next">
    <ListButton
      :label="loading ? '加载中…' : '加载更多'"
      :disabled="loading"
      @select="$emit('more')"
    />
  </ListSection>
  <p v-else-if="loading" class="footnote" role="status">正在读取收藏…</p>
  <p v-if="storage" class="footnote">{{ storage }}</p>
</template>
<style scoped>
.banner {
  margin: 0;
  padding: 14px var(--inset);
  font-size: 15px;
  line-height: 1.5;
}
.empty {
  margin: 0;
  padding: 48px 32px;
  text-align: center;
  font-size: 15px;
  line-height: 1.7;
  color: var(--subtle);
}
.footnote {
  margin: 0 0 16px;
  padding: 0 calc(var(--gutter) + 4px);
  text-align: center;
  font-size: 13px;
  color: var(--subtle);
}
</style>
