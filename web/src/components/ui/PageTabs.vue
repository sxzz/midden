<script setup vapor lang="ts">
import AppLink from './AppLink.vue'
import type { RouteLocationRaw } from 'vue-router'
// A page's tabs, as X's home has them: the labels share the width, the open
// one is bold over a short rounded bar, the others grey; a thin line under
// all of them. Each tab is a page of its own (a link). `end` holds a button
// at the right, where X has its +. Stays under the header as the page
// scrolls.
defineProps<{
  label: string
  tabs: { label: string; to: RouteLocationRaw; on: boolean }[]
}>()
</script>

<template>
  <nav class="page-tabs" :aria-label="label">
    <AppLink
      v-for="tab in tabs"
      :key="tab.label"
      class="tab"
      :class="{ on: tab.on }"
      :to="tab.to"
      :aria-current="tab.on ? 'page' : undefined"
    >
      <span class="text">{{ tab.label }}</span>
    </AppLink>
    <slot name="end" />
  </nav>
</template>

<style scoped>
.page-tabs {
  position: sticky;
  top: var(--page-header-height, 0px);
  z-index: 9;
  display: flex;
  align-items: stretch;
  height: 53px;
  margin: 0 0 12px;
  background: color-mix(in srgb, var(--page) 85%, transparent);
  -webkit-backdrop-filter: saturate(180%) blur(12px);
  backdrop-filter: saturate(180%) blur(12px);
  box-shadow: inset 0 -1px 0 var(--separator);
}
.tab {
  display: flex;
  flex: 1;
  justify-content: center;
  min-width: 0;
  color: var(--subtle);
  font-size: 15px;
  font-weight: 500;
  transition: background 120ms ease;
}
.tab:hover {
  background: color-mix(in srgb, var(--text) 6%, transparent);
}
.tab:focus-visible {
  outline-offset: -2px;
  border-radius: 0;
}
/* The label and the bar under it are as wide as the words. */
.text {
  position: relative;
  display: flex;
  align-items: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tab.on {
  color: var(--text);
  font-weight: 700;
}
.tab.on .text::after {
  content: '';
  position: absolute;
  inset: auto 0 0;
  height: 4px;
  border-radius: 999px;
  background: var(--link);
}
@media (prefers-reduced-motion: reduce) {
  .tab {
    transition: none;
  }
}
</style>
