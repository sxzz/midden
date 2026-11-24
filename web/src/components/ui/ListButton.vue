<script setup vapor lang="ts">
import AppLink from './AppLink.vue'
import type { RouteLocationRaw } from 'vue-router'
// A row of a grouped list: a page of the app (`to`), another site (`href`),
// or an action (`select`).
withDefaults(
  defineProps<{
    label: string
    hint?: string
    trailing?: string
    /** A route of the app: the row is a link to it. */
    to?: RouteLocationRaw
    /** Another site, opened in a new tab. */
    href?: string
    chevron?: boolean
    disabled?: boolean
    variant?: 'link' | 'plain' | 'destructive'
  }>(),
  { variant: 'link' },
)
const emit = defineEmits<{ select: []; navigate: [] }>()
</script>

<template>
  <AppLink
    v-if="to"
    class="row"
    :class="variant"
    :to="to"
    @navigate="emit('navigate')"
  >
    <span class="label"
      >{{ label }}<small v-if="hint" class="hint">{{ hint }}</small></span
    ><span v-if="trailing" class="trailing">{{ trailing }}</span
    ><span v-else-if="chevron" class="trailing chevron" aria-hidden="true"
      >›</span
    >
  </AppLink>
  <AppLink v-else-if="href" class="row link" :href="href">
    <span class="label">{{ label }}</span>
    <span class="trailing" aria-hidden="true">↗</span>
  </AppLink>
  <button
    v-else
    type="button"
    class="row"
    :class="variant"
    :disabled="disabled"
    @click="emit('select')"
  >
    <span class="label"
      >{{ label }}<small v-if="hint" class="hint">{{ hint }}</small></span
    ><span v-if="trailing" class="trailing">{{ trailing }}</span
    ><span v-else-if="chevron" class="trailing chevron" aria-hidden="true"
      >›</span
    >
  </button>
</template>

<style scoped>
.row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-height: 48px;
  padding: 11px var(--inset);
  background: none;
  font-size: 16px;
  color: var(--link);
}
.row + .row::before {
  content: '';
  position: absolute;
  inset: 0 0 auto var(--inset);
  height: 1px;
  background: var(--separator);
}
.row.plain {
  color: var(--text);
}
.row.destructive {
  color: var(--destructive);
}
.row:disabled {
  color: var(--subtle);
  opacity: 1;
}
.row.link:not(:disabled) .trailing {
  color: var(--link);
}
.row:active:not(:disabled) {
  background: var(--fill);
}
.label {
  flex: 1;
  min-width: 0;
}
.hint {
  display: block;
  font-size: 13px;
  color: var(--subtle);
}
.trailing {
  flex-shrink: 0;
  font-size: 15px;
  color: var(--subtle);
}
.chevron {
  font-size: 22px;
  line-height: 1;
  opacity: 0.55;
}
</style>
