<script setup vapor lang="ts">
import { shallowRef } from 'vue'
import QueryBox from './QueryBox.vue'
// The desktop sidebar's frame, as X has it beside the column: a search box
// at the top while `search` names what it searches, the page's boxes, then
// the small print. The owner's app (SideAside) and a public link
// (ShareAside) fill it; the owner's box takes the query language (`query`).
defineProps<{ search?: string; query?: boolean }>()
const emit = defineEmits<{ search: [q: string] }>()
const text = shallowRef('')
function submit() {
  const q = text.value.trim()
  if (!q) return
  emit('search', q)
  text.value = ''
}
</script>

<template>
  <aside class="aside" aria-label="侧栏">
    <div class="sticky">
      <div v-if="search && query" class="search query-search">
        <QueryBox
          v-model="text"
          :placeholder="search"
          :label="search"
          @submit="submit"
        />
      </div>
      <form
        v-else-if="search"
        class="search"
        role="search"
        @submit.prevent="submit"
      >
        <svg
          viewBox="0 0 24 24"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <circle cx="10.5" cy="10.5" r="6" />
          <path d="M15 15l4.5 4.5" />
        </svg>
        <input
          v-model="text"
          type="search"
          :placeholder="search"
          :aria-label="search"
          maxlength="500"
          enterkeyhint="search"
        />
      </form>
      <div class="content">
        <slot />
      </div>
      <footer class="aside-footer">
        <slot name="footer" />
      </footer>
    </div>
  </aside>
</template>

<style>
/* What the sidebars put in the frame. */
.aside-box {
  display: block;
  margin: 0 0 16px;
  padding: 0 0 8px;
  border-radius: 16px;
  background: var(--card);
  overflow: hidden;
}
/* The box clips what runs edge to edge in it, and the sidebar clips at its
   sides: rows and links there are ringed inside. */
.aside-box > :focus-visible,
.aside-box :is(.aside-row, .aside-more):focus-visible {
  outline-offset: -2px;
}
.aside-box > h2 {
  margin: 0;
  padding: 12px 16px 6px;
  font-size: 19px;
  font-weight: 800;
  line-height: 1.3;
}
.aside-more {
  display: block;
  padding: 9px 16px;
  font-size: 14px;
  color: var(--link);
}
.aside-more:hover {
  background: var(--fill);
}
.aside-facts {
  margin: 0;
  padding: 2px 16px 6px;
  font-size: 14px;
  color: var(--subtle);
  font-variant-numeric: tabular-nums;
}
/* A line that leads somewhere: a name, and a count after it. */
.aside-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  color: var(--text);
  font-size: 15px;
}
.aside-row:hover {
  background: var(--fill);
}
.aside-row[aria-current='page'] {
  font-weight: 700;
}
.aside-row-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.aside-row-count {
  flex: none;
  font-size: 13px;
  color: var(--subtle);
  font-variant-numeric: tabular-nums;
}
/* How far an update is, as the records' list draws it. */
.aside-progress {
  display: block;
  width: 100%;
  height: 4px;
  margin-top: 8px;
  border: 0;
  border-radius: 2px;
  background: var(--fill);
  accent-color: var(--link);
  appearance: none;
  overflow: hidden;
}
.aside-progress::-webkit-progress-bar {
  background: var(--fill);
}
.aside-progress::-webkit-progress-value {
  background: var(--link);
  transition: width 300ms ease;
}
.aside-progress::-moz-progress-bar {
  background: var(--link);
}
.aside-footer {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  padding: 0 16px;
  font-size: 13px;
  color: var(--subtle);
}
.aside-footer a {
  color: var(--subtle);
}
.aside-footer a:hover {
  text-decoration: underline;
}
</style>

<style scoped>
/* 350px wide, 30px from the column, as X's; narrower until 1100px, so the
   rail, the column and it fit from 1000px (layout.ts, style.css). */
/* Sticky as the row's item, as the rail (see SideRail). */
.aside {
  position: sticky;
  top: 0;
  flex: none;
  align-self: flex-start;
  width: var(--sidebar-width);
  margin-left: var(--sidebar-gap);
}
/* A long sidebar scrolls on its own, and only up and down. */
.sticky {
  max-height: 100dvh;
  padding-bottom: 32px;
  overflow: hidden auto;
  scrollbar-width: none;
}
.search {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  margin: 0 0 12px;
  padding: 6px 0;
  background: var(--page);
  color: var(--subtle);
}
.search:not(.query-search) > svg {
  position: absolute;
  left: 16px;
  pointer-events: none;
}
.search:not(.query-search) input {
  width: 100%;
  height: 42px;
  padding: 0 16px 0 44px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: var(--fill);
  color: var(--text);
  font-size: 15px;
}
.search:not(.query-search) input:focus {
  outline: none;
  border-color: var(--link);
  background: var(--page);
}
.search:not(.query-search) input::placeholder {
  color: var(--subtle);
}
.content {
  padding-top: 12px;
}
.search + .content {
  padding-top: 0;
}
.query-search {
  display: block;
}
</style>
