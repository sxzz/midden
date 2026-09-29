<script setup vapor lang="ts">
import type { Revision } from "../api";
import { date } from "../presentation";
import ListButton from "./ui/ListButton.vue";
defineProps<{
  revisions: Revision[];
  next: string;
  busy?: boolean;
  loading?: boolean;
  selectedId: string;
  latestId: string;
}>();
defineEmits<{ select: [id: string]; more: [] }>();
</script>
<template>
  <div class="revisions">
    <ListButton
      v-for="r in revisions"
      :key="r.id"
      :label="`${r.id === latestId ? '最新版本 · ' : ''}${date(r.created_at)}`"
      :trailing="r.id === selectedId ? '正在查看' : '查看'"
      :disabled="busy || r.id === selectedId"
      @select="$emit('select', r.id)"
    />
    <div
      v-if="loading"
      class="history-loading"
      role="status"
      aria-label="正在加载历史版本"
      aria-busy="true"
    >
      <span class="skeleton" /><span class="skeleton" />
    </div>
    <ListButton
      v-if="next"
      label="更多版本"
      :disabled="busy || loading"
      @select="$emit('more')"
    />
  </div>
</template>
<style scoped>
.revisions {
  border-top: 1px solid var(--separator);
  margin-left: var(--inset);
}
.history-loading {
  display: grid;
  gap: 20px;
  padding: 16px;
}
.history-loading span {
  height: 16px;
  width: 75%;
  border-radius: 4px;
}
</style>
