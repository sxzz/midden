<script setup vapor lang="ts">
import AppLink from './AppLink.vue'
import ChevronIcon from './ChevronIcon.vue'
import type { RouteLocationRaw } from 'vue-router'
// A section of a page that opens in place under its heading (设置). The
// heading is a link to the page with the section open, or closed when it
// is open, so the address always says what is open and a new tab opens
// the same; it replaces the entry, as opening is not going anywhere.
defineProps<{
  label: string
  hint?: string
  open: boolean
  to: RouteLocationRaw
  /** One inside another's content: lighter, to read as a part of it. */
  nested?: boolean
}>()
</script>

<template>
  <section class="disclosure" :class="{ open, nested }">
    <AppLink class="disclosure-head" :to="to" replace :aria-expanded="open">
      <span class="label"
        >{{ label }}<small v-if="hint" class="hint">{{ hint }}</small></span
      >
      <ChevronIcon :open="open" />
    </AppLink>
    <div v-if="open" class="body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.disclosure {
  margin: 0 0 12px;
}
.disclosure-head {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 52px;
  margin: 0 var(--gutter);
  padding: 12px var(--inset);
  border-radius: var(--radius);
  background: var(--card);
  color: var(--text);
  font-size: 16px;
}
.disclosure-head:hover {
  background: color-mix(in srgb, var(--card) 90%, var(--text) 6%);
}
.open > .disclosure-head {
  font-weight: 600;
}
.label {
  display: grid;
  flex: 1;
  min-width: 0;
}
.hint {
  font-size: 13px;
  font-weight: 400;
  color: var(--subtle);
}
.disclosure-head :deep(svg) {
  flex: none;
  color: var(--subtle);
}
.body {
  padding-top: 12px;
}
.nested > .disclosure-head {
  min-height: 46px;
  padding: 10px var(--inset);
  background: none;
  box-shadow: inset 0 0 0 1px var(--separator);
  font-size: 15px;
}
.nested > .disclosure-head:hover {
  background: var(--fill);
}
</style>
