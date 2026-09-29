<script setup vapor lang="ts">
import { computed } from "vue";
import { assetURL, type Archive } from "../api";
import { excerpt, mediaSummary, present, shortDate } from "../presentation";
import MediaThumbs from "./MediaThumbs.vue";
const props = defineProps<{ archive: Archive }>();
defineEmits<{ open: [id: string] }>();
const view = computed(() => present(props.archive));
const preview = computed(() => excerpt(view.value.body));
const meta = computed(() =>
  [
    view.value.handle && "@" + view.value.handle,
    props.archive.visibility === "private" && "私密",
    mediaSummary(props.archive.assets),
  ]
    .filter(Boolean)
    .join(" · "),
);
</script>
<template>
  <button type="button" class="row" @click="$emit('open', archive.id)">
    <img
      v-if="view.avatar"
      class="avatar"
      :src="assetURL(view.avatar)"
      alt=""
      loading="lazy"
    /><span v-else class="avatar initials" aria-hidden="true">{{
      view.name.slice(0, 1)
    }}</span>
    <span class="content">
      <span class="head">
        <strong class="name">{{ view.name }}</strong
        ><span class="when">{{
          shortDate(archive.saved_at || archive.observed_at)
        }}</span>
      </span>
      <span class="preview">{{ preview }}</span>
      <span v-if="meta" class="meta">{{ meta }}</span>
      <MediaThumbs :assets="archive.assets || []" />
    </span>
  </button>
</template>
<style scoped>
.row {
  position: relative;
  display: flex;
  gap: 12px;
  width: 100%;
  padding: 11px var(--inset);
  background: none;
}
.row + .row::before {
  content: "";
  position: absolute;
  inset: 0 0 auto calc(var(--inset) + 52px);
  height: 1px;
  background: var(--separator);
}
.row:active {
  background: var(--fill);
}
.avatar {
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  border-radius: 50%;
  object-fit: cover;
  background: var(--fill);
}
.initials {
  display: grid;
  place-items: center;
  font-size: 17px;
  font-weight: 600;
  color: var(--link);
}
.content {
  flex: 1;
  min-width: 0;
}
.head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.name {
  flex: 1;
  min-width: 0;
  font-size: 16px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.when {
  flex-shrink: 0;
  font-size: 13px;
  color: var(--subtle);
}
.preview {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin-top: 2px;
  font-size: 15px;
  line-height: 1.45;
  color: var(--subtle);
}
.meta {
  display: block;
  margin-top: 3px;
  font-size: 13px;
  color: var(--subtle);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
