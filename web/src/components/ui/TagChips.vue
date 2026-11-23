<script setup vapor lang="ts">
import { useId } from 'vue'
import type { Tag } from '../../api'
const props = defineProps<{
  /** Names the group for assistive tech; the visible heading stays outside,
      so each caller can match its own surrounding typography. */
  label: string
  tags: Tag[]
  /** Several tags at once; otherwise the chips behave as radio buttons. */
  multiple?: boolean
  /** Single choice only: a leading chip standing for "no tag selected". */
  allLabel?: string
}>()
const selected = defineModel<string[]>({ required: true })
// Radios only form a group per `name`, so two groups on one page must differ.
const group = useId()
function pick(id: string) {
  if (!props.multiple) {
    selected.value = id ? [id] : []
    return
  }
  selected.value = selected.value.includes(id)
    ? selected.value.filter((item) => item !== id)
    : [...selected.value, id]
}
</script>

<template>
  <div
    class="chips"
    :role="multiple ? 'group' : 'radiogroup'"
    :aria-label="label"
  >
    <label v-if="allLabel" class="chip">
      <input
        type="radio"
        :name="group"
        :checked="!selected.length"
        @change="pick('')"
      /><span>{{ allLabel }}</span>
    </label>
    <label v-for="tag in tags" :key="tag.id" class="chip">
      <input
        :type="multiple ? 'checkbox' : 'radio'"
        :name="group"
        :checked="selected.includes(tag.id)"
        @change="pick(tag.id)"
      /><span>{{ tag.name }}</span>
    </label>
  </div>
</template>

<style scoped>
/* Tags wrap inline so the whole vocabulary is visible at a glance. The
   negative margin pays back the padding that keeps focus rings and the
   enlarged tap areas from being clipped once the list starts scrolling. */
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  max-height: 228px;
  margin: -6px -4px;
  padding: 6px 4px;
  overflow: auto;
  overscroll-behavior: contain;
}
.chip {
  position: relative;
  display: inline-flex;
  max-width: 100%;
  cursor: pointer;
  user-select: none;
}
/* The pill stays 34px so a long vocabulary reads as one block; the invisible
   inset restores a comfortable target for a thumb. */
.chip::before {
  content: '';
  position: absolute;
  inset-block: -5px;
  inset-inline: 0;
}
.chip input {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: 0;
  padding: 0;
  border: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.chip span {
  display: inline-flex;
  align-items: center;
  min-height: 34px;
  padding: 6px 13px;
  border-radius: 999px;
  background: var(--fill);
  font-size: 14px;
  line-height: 1.3;
  overflow-wrap: anywhere;
  transition:
    background-color 0.15s ease,
    box-shadow 0.15s ease,
    transform 0.12s ease;
}
/* Selection reads as a tinted, ringed pill, which stays legible in both
   themes where a solid accent fill would not. */
.chip input:checked + span {
  background: color-mix(in srgb, var(--link) 16%, transparent);
  box-shadow: inset 0 0 0 1.5px var(--link);
  color: var(--link);
  font-weight: 600;
}
.chip input:focus-visible + span {
  outline: 2px solid var(--link);
  outline-offset: 2px;
}
/* A save in flight disables the enclosing fieldset; the chips should say so. */
.chip input:disabled + span {
  opacity: 0.5;
}
@media (hover: hover) {
  .chip:hover input:not(:checked) + span {
    background: color-mix(in srgb, var(--text) 7%, var(--fill));
  }
}
.chip:active span {
  transform: scale(0.97);
}
@media (prefers-reduced-motion: reduce) {
  .chip span {
    transition: none;
  }
  .chip:active span {
    transform: none;
  }
}
</style>
