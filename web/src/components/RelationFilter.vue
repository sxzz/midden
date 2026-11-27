<script setup vapor lang="ts">
import { computed, shallowRef, watch } from 'vue'
import {
  briefFetchNote,
  defaultRelMin,
  fetchNote,
  perspectiveName,
  relationChip,
  RELS,
  type Rel,
} from '../relation-filter'
import PerspectivePicker from './PerspectivePicker.vue'
import type { Perspective } from '../api'
// The 「关系」 section of the filters: whose follows, which of them, and with
// several accounts, how many of them an account must relate to.
const relOf = defineModel<string[]>('relOf', { required: true })
const rel = defineModel<Rel | ''>('rel', { required: true })
/** The threshold; 0 for the default. */
const relMin = defineModel<number>('relMin', { required: true })
const emit = defineEmits<{
  /** The filter in the summary's words, empty without one. */
  summary: [text: string]
}>()
const known = shallowRef<Record<string, Perspective>>({})
const selected = computed({
  get: () => relOf.value,
  set(value: string[]) {
    // Picking an account starts from whom it follows.
    rel.value = value.length ? rel.value || 'following' : ''
    // A threshold beyond the accounts left falls back to the default.
    if (relMin.value > value.length || value.length < 2) relMin.value = 0
    relOf.value = value
  },
})
const min = computed(() => relMin.value || defaultRelMin(relOf.value.length))
function step(by: number) {
  const value = Math.min(relOf.value.length, Math.max(1, min.value + by))
  relMin.value = value === defaultRelMin(relOf.value.length) ? 0 : value
}
const nameOf = (key: string) => perspectiveName(key, known.value[key])
const notes = computed(() => {
  const mode = rel.value
  if (!mode) return []
  if (relOf.value.length === 1) {
    const one = known.value[relOf.value[0]!]
    return one ? [fetchNote(one, mode)] : []
  }
  return relOf.value.flatMap((key) =>
    known.value[key]
      ? [briefFetchNote(nameOf(key), known.value[key], mode)]
      : [],
  )
})
watch(
  () =>
    relOf.value.length && rel.value
      ? relationChip(rel.value, relOf.value.map(nameOf), min.value)
      : '',
  (text) => emit('summary', text),
  { immediate: true },
)
</script>

<template>
  <div class="relation">
    <PerspectivePicker
      v-model="selected"
      label="关系"
      @known="(value) => (known = value)"
    />
    <div v-if="relOf.length" class="mode">
      <div class="segments" role="radiogroup" aria-label="关系方向">
        <label v-for="option in RELS" :key="option.value"
          ><input v-model="rel" type="radio" :value="option.value" /><span>{{
            option.label
          }}</span></label
        >
      </div>
      <div
        v-if="relOf.length > 1"
        class="min"
        role="group"
        aria-label="至少几人"
      >
        <span class="min-label">至少</span>
        <button
          type="button"
          class="step"
          aria-label="减少"
          :disabled="min <= 1"
          @click="step(-1)"
        >
          −
        </button>
        <output class="min-value" aria-live="polite">{{ min }}</output>
        <button
          type="button"
          class="step"
          aria-label="增加"
          :disabled="min >= relOf.length"
          @click="step(1)"
        >
          +
        </button>
        <span class="min-label">人 / 共{{ relOf.length }}人</span>
      </div>
      <ul v-if="notes.length" class="note">
        <li v-for="note in notes" :key="note">{{ note }}</li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.mode {
  padding: 0 var(--inset) 12px;
}
.segments {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: 9px;
  background: var(--fill);
}
.segments label {
  position: relative;
  flex: 1;
  cursor: pointer;
}
.segments input {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: 0;
  overflow: hidden;
  clip-path: inset(50%);
}
.segments span {
  display: block;
  padding: 6px 8px;
  border-radius: 7px;
  font-size: 13px;
  text-align: center;
  white-space: nowrap;
}
.segments input:checked + span {
  background: var(--card);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
  font-weight: 600;
}
.segments input:focus-visible + span {
  outline: 2px solid var(--link);
  outline-offset: 1px;
}
.min {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  font-size: 14px;
}
.min-label {
  color: var(--subtle);
}
.step {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--fill);
  color: var(--text);
  font-size: 18px;
  line-height: 1;
}
.step:disabled {
  opacity: 0.35;
}
.step:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: 2px;
}
.min-value {
  min-width: 1.5em;
  font-weight: 600;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.note {
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
  color: var(--subtle);
  font-size: 12px;
  line-height: 1.5;
}
</style>
