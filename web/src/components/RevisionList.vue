<script setup vapor lang="ts">
import type { Revision } from "../api";
import { date } from "../presentation";
import ListSection from "./ui/ListSection.vue";
import ListButton from "./ui/ListButton.vue";
defineProps<{
  revisions: Revision[];
  next: string;
  busy?: boolean;
  current?: boolean;
}>();
defineEmits<{ select: [id?: string]; more: [] }>();
</script>
<template>
  <ListSection title="历史版本" footnote="每次重新抓取都会留下一个版本。">
    <ListButton
      v-if="!current"
      label="当前版本"
      variant="plain"
      trailing="查看"
      :disabled="busy"
      @select="$emit('select')"
    />
    <ListButton
      v-for="r in revisions"
      :key="r.id"
      :label="date(r.created_at)"
      variant="plain"
      chevron
      :disabled="busy"
      @select="$emit('select', r.id)"
    />
    <ListButton v-if="next" label="更多版本" @select="$emit('more')" />
  </ListSection>
</template>
