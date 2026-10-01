<script setup vapor lang="ts">
import { computed, shallowRef, useTemplateRef } from 'vue'
import ChevronIcon from './ChevronIcon.vue'
const props = withDefaults(
  defineProps<{
    label: string
    options: { value: string; label: string }[]
    searchable?: boolean
  }>(),
  { searchable: true },
)
const selected = defineModel<string[]>({ required: true })
const query = shallowRef('')
const open = shallowRef(false)
const dropdown = useTemplateRef<HTMLDetailsElement>('dropdown')
const choices = computed(() => {
  const options = [...props.options]
  for (const value of selected.value)
    if (!options.some((option) => option.value === value))
      options.push({ value, label: value })
  if (!props.searchable) return options
  return options.filter((option) =>
    option.label.toLocaleLowerCase().includes(query.value.toLocaleLowerCase()),
  )
})
const summary = computed(
  () =>
    selected.value
      .map(
        (value) =>
          props.options.find((option) => option.value === value)?.label ||
          value,
      )
      .join('、') || '全部',
)
function toggle(value: string) {
  selected.value = selected.value.includes(value)
    ? selected.value.filter((item) => item !== value)
    : [...selected.value, value]
}
function close(event: KeyboardEvent) {
  event.preventDefault()
  if (dropdown.value) {
    dropdown.value.open = false
    dropdown.value.querySelector('summary')?.focus()
  }
}
const steps: Record<string, number> = {
  ArrowDown: 1,
  ArrowRight: 1,
  ArrowUp: -1,
  ArrowLeft: -1,
}
function navigate(event: KeyboardEvent) {
  if (!(event.key in steps) && !['Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const buttons = [
    ...(event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>(
      '[role="option"]',
    ),
  ]
  let index = buttons.indexOf(event.target as HTMLButtonElement)
  if (event.key === 'Home') index = 0
  else if (event.key === 'End') index = buttons.length - 1
  else index = (index + steps[event.key]! + buttons.length) % buttons.length
  buttons[index]?.focus()
}
</script>

<template>
  <details
    ref="dropdown"
    class="multi-select"
    @keydown.esc="close"
    @toggle="open = ($event.target as HTMLDetailsElement).open"
  >
    <summary :aria-label="label">
      <span>{{ label }}</span
      ><span class="value">{{ summary }}</span>
      <ChevronIcon :open="open" />
    </summary>
    <div class="choices">
      <input
        v-if="searchable"
        v-model="query"
        type="search"
        :aria-label="`搜索${label}`"
        placeholder="搜索"
        @keydown.enter.prevent
      />
      <button
        v-if="selected.length"
        type="button"
        class="clear"
        @click="selected = []"
      >
        清空选择
      </button>
      <!-- Tags wrap inline: the whole vocabulary is visible at a glance
           instead of one narrow scrolling column of rows. -->
      <div
        role="listbox"
        :aria-label="label"
        aria-multiselectable="true"
        class="options"
        @keydown="navigate"
      >
        <button
          v-for="option in choices"
          :key="option.value"
          type="button"
          role="option"
          class="tag"
          :aria-selected="selected.includes(option.value)"
          @click="toggle(option.value)"
        >
          {{ option.label }}
        </button>
      </div>
      <p v-if="!choices.length" class="empty">没有匹配项</p>
    </div>
  </details>
</template>

<style scoped>
.multi-select {
  border-bottom: 1px solid var(--separator);
  font-size: 15px;
}
summary {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 44px;
  padding: 2px var(--inset);
  cursor: pointer;
  list-style: none;
}
summary::-webkit-details-marker {
  display: none;
}
.value {
  margin-left: auto;
  max-width: 65%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--link);
}
.choices {
  padding: 0 var(--inset) 10px;
}
input {
  width: 100%;
  min-height: 40px;
  padding: 8px;
  border: 0;
  border-radius: 8px;
  background: var(--fill);
  font: inherit;
}
.options {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  max-height: 220px;
  overflow-y: auto;
  padding: 8px 0 2px;
}
.tag {
  max-width: 100%;
  min-height: 34px;
  padding: 6px 13px;
  border-radius: 999px;
  background: var(--fill);
  color: inherit;
  font-size: 14px;
  line-height: 1.3;
  text-align: left;
  overflow-wrap: anywhere;
  transition: background-color 0.15s ease;
}
/* Selection reads as a tinted, ringed pill, which stays legible in both
   themes where a solid accent fill would not. */
.tag[aria-selected='true'] {
  background: color-mix(in srgb, var(--link) 16%, transparent);
  box-shadow: inset 0 0 0 1.5px var(--link);
  color: var(--link);
  font-weight: 600;
}
.tag:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: 2px;
}
@media (prefers-reduced-motion: reduce) {
  .tag {
    transition: none;
  }
}
.clear {
  color: var(--link);
  min-height: 40px;
}
.empty {
  color: var(--subtle);
  font-size: 13px;
}
</style>
