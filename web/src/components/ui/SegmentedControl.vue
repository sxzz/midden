<script setup vapor lang="ts">
import { useId } from 'vue'
// One of a few values, all in view: a row of segments, the chosen one
// raised. Radio buttons underneath, so arrows move between them and a
// screen reader reads a group. Compact, for the sidebar's 筛选 card.
defineProps<{
  /** Names the group; the visible heading is the caller's. */
  label: string
  options: readonly { value: string; label: string }[]
}>()
const model = defineModel<string>({ required: true })
const name = useId()
</script>

<template>
  <div class="segmented" role="radiogroup" :aria-label="label">
    <label
      v-for="option in options"
      :key="option.value"
      class="segment"
      :class="{ chosen: model === option.value }"
      ><input
        v-model="model"
        type="radio"
        :name="name"
        :value="option.value"
      /><span>{{ option.label }}</span></label
    >
  </div>
</template>

<style scoped>
.segmented {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: 9px;
  background: var(--fill);
}
.segment {
  position: relative;
  display: grid;
  flex: 1 1 0;
  place-items: center;
  min-width: 0;
  min-height: 28px;
  padding: 0 4px;
  border-radius: 7px;
  color: var(--subtle);
  font-size: 13px;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background 120ms ease,
    color 120ms ease;
}
.segment span {
  overflow: hidden;
  text-overflow: ellipsis;
}
.segment:hover:not(.chosen) {
  color: var(--text);
}
.segment.chosen {
  background: var(--card);
  color: var(--text);
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
}
.segment input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}
/* The ring follows the segment, inside the group's rounded edge. */
.segment:has(input:focus-visible) {
  outline: 2px solid var(--link);
  outline-offset: -2px;
}
@media (prefers-reduced-motion: reduce) {
  .segment {
    transition: none;
  }
}
</style>
