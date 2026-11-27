<script setup vapor lang="ts">
import { watch } from 'vue'
import type { Tag } from '../../api'
defineProps<{
  /** Names the group for assistive tech; the heading stays outside. */
  label: string
  tags: Tag[]
}>()
/** Tags a collection should have. */
const include = defineModel<string[]>('include', { required: true })
/** Tags a collection must not have. */
const exclude = defineModel<string[]>('exclude', { required: true })
// The models change only once the parent renders again; picks made before
// that build on the last one instead of the stale models.
type Lists = { include: string[]; exclude: string[] }
let pending: Lists | undefined
watch([include, exclude], () => (pending = undefined))
const stateIn = (lists: Lists, id: string) =>
  lists.include.includes(id)
    ? 'include'
    : lists.exclude.includes(id)
      ? 'exclude'
      : ''
/** What a chip shows, read from the models so it renders again with them. */
const state = (id: string) =>
  stateIn({ include: include.value, exclude: exclude.value }, id)
/** Each tap moves a tag on: wanted, then excluded, then neither. */
function cycle(id: string) {
  const now = pending ?? { include: include.value, exclude: exclude.value }
  const was = stateIn(now, id)
  pending = {
    include:
      was === ''
        ? [...now.include, id]
        : now.include.filter((item) => item !== id),
    exclude:
      was === 'include'
        ? [...now.exclude, id]
        : now.exclude.filter((item) => item !== id),
  }
  include.value = pending.include
  exclude.value = pending.exclude
}
function clear() {
  pending = { include: [], exclude: [] }
  include.value = []
  exclude.value = []
}
const stateNames = { include: '包含', exclude: '排除', '': '不限' }
</script>

<template>
  <div class="chips" role="group" :aria-label="label">
    <button
      type="button"
      class="chip"
      :aria-pressed="!include.length && !exclude.length"
      @click="clear"
    >
      全部
    </button>
    <button
      v-for="tag in tags"
      :key="tag.id"
      type="button"
      class="chip"
      :class="state(tag.id)"
      :aria-label="`${tag.name}：${stateNames[state(tag.id)]}`"
      @click="cycle(tag.id)"
    >
      {{ tag.name }}
    </button>
  </div>
</template>

<style scoped>
/* The same pills as the tag picker elsewhere, with a third state. */
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
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  min-height: 34px;
  padding: 6px 13px;
  border-radius: 999px;
  background: var(--fill);
  font-size: 14px;
  line-height: 1.3;
  text-align: start;
  overflow-wrap: anywhere;
  transition:
    background-color 0.15s ease,
    box-shadow 0.15s ease,
    transform 0.12s ease;
}
.chip[aria-pressed='true'],
.chip.include {
  background: color-mix(in srgb, var(--link) 16%, transparent);
  box-shadow: inset 0 0 0 1.5px var(--link);
  color: var(--link);
  font-weight: 600;
}
/* Excluded: struck through in the destructive colour, so the name alone
   says it without a word before it. */
.chip.exclude {
  background: color-mix(in srgb, var(--destructive) 12%, transparent);
  box-shadow: inset 0 0 0 1.5px var(--destructive);
  color: var(--destructive);
  font-weight: 600;
  text-decoration: line-through;
  text-decoration-thickness: 1.5px;
}
.chip:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: 2px;
}
.chip:active {
  transform: scale(0.97);
}
@media (prefers-reduced-motion: reduce) {
  .chip {
    transition: none;
  }
  .chip:active {
    transform: none;
  }
}
</style>
