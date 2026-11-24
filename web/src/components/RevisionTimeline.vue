<script setup vapor lang="ts">
import { computed, shallowRef, watch } from 'vue'
import { date } from '../presentation'
import type { HistoryPoint } from '../api'
const props = defineProps<{
  /**
   * Captures where the content or counts changed, newest first, as the API
   * pages them.
   */
  points: HistoryPoint[]
  /** Capture ids of the point shown and of the newest point. */
  selectedId: string
  latestId: string
  /** Older points remain to be loaded. */
  more: boolean
  loading?: boolean
  /** Names the slider for what changes across points. */
  label: string
}>()
const emit = defineEmits<{ select: [id: string]; more: [] }>()
// Oldest on the left, so dragging right moves forward in time.
const ordered = computed(() => props.points.toReversed())
// The point under the thumb, ahead of the one shown while it loads.
const current = shallowRef(props.selectedId)
watch(
  () => props.selectedId,
  (id) => (current.value = id),
)
const index = computed(() =>
  Math.max(
    0,
    ordered.value.findIndex((p) => p.capture_id === current.value),
  ),
)
const last = computed(() => ordered.value.length - 1)
const at = computed(() => ordered.value[index.value])
const latest = computed(() => at.value?.capture_id === props.latestId)
// One dot per point while they stay apart; past that the track says enough.
const MAX_TICKS = 60
const ticks = computed(() =>
  last.value > 0 && last.value < MAX_TICKS
    ? ordered.value.map((p, i) => ({ id: p.capture_id, at: i / last.value }))
    : [],
)
function move(event: Event) {
  const point = ordered.value[Number((event.target as HTMLInputElement).value)]
  if (!point || point.capture_id === current.value) return
  current.value = point.capture_id
  emit('select', point.capture_id)
}
// Resting on the oldest loaded point asks for the ones before it.
function settle() {
  if (index.value === 0 && props.more && !props.loading) emit('more')
}
</script>

<template>
  <div class="timeline">
    <p class="when">
      <strong>{{ date(at?.observed_at) }}</strong>
      <span class="where">{{
        latest ? '最新版本' : `第 ${index + 1} / ${last + 1} 次`
      }}</span>
    </p>
    <div class="track">
      <div class="ticks" aria-hidden="true">
        <span
          v-for="tick in ticks"
          :key="tick.id"
          class="tick"
          :class="{ on: tick.id === at?.capture_id }"
          :style="{ '--at': tick.at }"
        />
      </div>
      <input
        type="range"
        min="0"
        :max="last"
        step="1"
        :value="index"
        :aria-label="label"
        :aria-valuetext="`${date(at?.observed_at)}${latest ? '，最新版本' : ''}`"
        @input="move"
        @change="settle"
      />
    </div>
    <p class="ends">
      <button
        v-if="more"
        type="button"
        class="older"
        :disabled="loading"
        @click="emit('more')"
      >
        {{ loading ? '正在加载…' : '更早的记录' }}
      </button>
      <span v-else>{{ date(ordered[0]?.observed_at) }}</span>
      <span>最新</span>
    </p>
  </div>
</template>

<style scoped>
.timeline {
  --thumb: 22px;
  padding: 12px var(--inset) 10px;
}
.when {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin: 0 0 6px;
  font-size: 15px;
}
.when strong {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.where {
  color: var(--subtle);
  font-size: 13px;
  white-space: nowrap;
}
.track {
  position: relative;
  height: 36px;
}
/* Dots sit where the thumb's centre stops for each revision. */
.ticks {
  position: absolute;
  inset: 0 calc(var(--thumb) / 2);
  pointer-events: none;
}
.tick {
  position: absolute;
  top: 50%;
  left: calc(var(--at) * 100%);
  width: 6px;
  height: 6px;
  margin: -3px 0 0 -3px;
  border-radius: 50%;
  background: var(--subtle);
  opacity: 0.45;
}
.tick.on {
  opacity: 0;
}
input[type='range'] {
  position: relative;
  width: 100%;
  height: 36px;
  margin: 0;
  background: none;
  appearance: none;
  -webkit-appearance: none;
  touch-action: pan-y;
  cursor: pointer;
}
input[type='range']::-webkit-slider-runnable-track {
  height: 4px;
  border-radius: 2px;
  background: var(--fill);
}
input[type='range']::-moz-range-track {
  height: 4px;
  border-radius: 2px;
  background: var(--fill);
}
input[type='range']::-webkit-slider-thumb {
  width: var(--thumb);
  height: var(--thumb);
  margin-top: calc((4px - var(--thumb)) / 2);
  border: 0;
  border-radius: 50%;
  background: var(--link);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
  -webkit-appearance: none;
}
input[type='range']::-moz-range-thumb {
  width: var(--thumb);
  height: var(--thumb);
  border: 0;
  border-radius: 50%;
  background: var(--link);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
}
input[type='range']:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: 2px;
  border-radius: 4px;
}
.ends {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 28px;
  margin: 0;
  color: var(--subtle);
  font-size: 12px;
}
.older {
  min-height: 28px;
  padding: 0;
  color: var(--link);
  font-size: 12px;
}
.older:disabled {
  color: var(--subtle);
}
</style>
