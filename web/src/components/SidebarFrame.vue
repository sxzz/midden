<script setup vapor lang="ts">
import { shallowRef } from 'vue'
// The desktop sidebar's frame, as X has it beside the column: a search box
// at the top while `search` names what it searches, the page's boxes, then
// the small print. The owner's app (SideAside) and a public link
// (ShareAside) fill it.
defineProps<{ search?: string }>()
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
      <form v-if="search" class="search" role="search" @submit.prevent="submit">
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
   rail, the column and it fit from 1000px (layout.ts). */
.aside {
  flex: none;
  width: 290px;
  margin-left: 16px;
}
@media (min-width: 1100px) {
  .aside {
    width: 350px;
    margin-left: 30px;
  }
}
/* The sidebar stays in view; a long one scrolls on its own. */
.sticky {
  position: sticky;
  top: 0;
  max-height: 100dvh;
  padding-bottom: 32px;
  overflow-y: auto;
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
.search svg {
  position: absolute;
  left: 16px;
  pointer-events: none;
}
.search input {
  width: 100%;
  height: 42px;
  padding: 0 16px 0 44px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: var(--fill);
  color: var(--text);
  font-size: 15px;
}
.search input:focus {
  outline: none;
  border-color: var(--link);
  background: var(--page);
}
.search input::placeholder {
  color: var(--subtle);
}
.content {
  padding-top: 12px;
}
.search + .content {
  padding-top: 0;
}
</style>
