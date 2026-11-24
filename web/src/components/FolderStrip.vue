<script setup vapor lang="ts">
import { RouterLink } from 'vue-router'
import { folderQuery } from '../folders'
import type { Folder } from '../api'
defineProps<{ folders: Folder[] }>()
const link = (folder: Folder) => {
  const query = folderQuery(folder.filter)
  return `/folder/${folder.id}${query ? `?${query}` : ''}`
}
</script>

<template>
  <nav v-if="folders.length" class="folders" aria-label="收藏夹">
    <RouterLink
      v-for="folder in folders"
      :key="folder.id"
      class="folder"
      :to="link(folder)"
    >
      <svg
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path
          d="M3 7.5V18a1.5 1.5 0 0 0 1.5 1.5h15A1.5 1.5 0 0 0 21 18V9a1.5 1.5 0 0 0-1.5-1.5H12L10 5H4.5A1.5 1.5 0 0 0 3 6.5Z"
        />
      </svg>
      <span class="name">{{ folder.name }}</span>
      <span class="count">{{ folder.count }}</span>
    </RouterLink>
  </nav>
</template>

<style scoped>
/* One scrolling line, so many folders never push the list down. The
   padding keeps focus rings from being clipped by the scroller. */
.folders {
  display: flex;
  gap: 8px;
  margin: -2px 0 4px;
  padding: 2px calc(var(--gutter) + 2px) 6px;
  overflow-x: auto;
  scrollbar-width: none;
  overscroll-behavior-x: contain;
}
.folders::-webkit-scrollbar {
  display: none;
}
.folder {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 6px;
  max-width: 70%;
  min-height: 34px;
  padding: 0 12px 0 10px;
  border-radius: 999px;
  background: var(--fill);
  color: var(--text);
  font-size: 14px;
  line-height: 1.3;
}
.folder svg {
  flex: none;
  color: var(--subtle);
}
.name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.count {
  flex: none;
  color: var(--subtle);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}
.folder:active {
  opacity: 0.7;
}
.folder:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: 2px;
}
</style>
