<script setup vapor lang="ts">
import {
  computed,
  onMounted,
  onUnmounted,
  shallowRef,
  useTemplateRef,
} from 'vue'
import { date } from '../presentation'
import {
  change,
  formatChange,
  formatCount,
  frame,
  geometry,
  nearest,
  type Trend,
} from '../trends'
const props = defineProps<{
  trend: Trend
  /** The capture being inspected on any chart of the page. */
  selectedId?: string
}>()
const emit = defineEmits<{ inspect: [id: string | undefined] }>()
const HEIGHT = 132
const plot = useTemplateRef<HTMLDivElement>('plot')
// Drawn in real pixels rather than a stretched viewBox, so lines and labels
// keep their size at any width.
const width = shallowRef(320)
let observer: ResizeObserver | undefined
onMounted(() => {
  const el = plot.value
  if (!el) return
  if (el.clientWidth) width.value = el.clientWidth
  if (typeof ResizeObserver === 'undefined') return
  observer = new ResizeObserver(([entry]) => {
    if (entry?.contentRect.width) width.value = entry.contentRect.width
  })
  observer.observe(el)
})
onUnmounted(() => observer?.disconnect())
const box = computed(() => frame(width.value, HEIGHT))
const shape = computed(() => geometry(props.trend, box.value))
const last = computed(() => props.trend.points.length - 1)
const active = computed(() =>
  props.selectedId
    ? props.trend.points.findIndex((p) => p.id === props.selectedId)
    : -1,
)
const shown = computed(
  () => props.trend.points[active.value < 0 ? last.value : active.value]!,
)
// Every reading gets a dot while there is room for them to stay apart.
const dots = computed(
  () => props.trend.points.length * 16 <= box.value.right - box.value.left,
)
function pick(event: PointerEvent) {
  const rect = plot.value!.getBoundingClientRect()
  const index = nearest(shape.value.xs, event.clientX - rect.left)
  emit('inspect', props.trend.points[index]?.id)
}
function move(event: PointerEvent) {
  // A mouse inspects as it hovers; a finger only while it is down.
  if (event.pointerType === 'mouse' || event.buttons) pick(event)
}
function leave(event: PointerEvent) {
  if (event.pointerType === 'mouse') emit('inspect', undefined)
}
function key(event: KeyboardEvent) {
  const from = active.value < 0 ? last.value : active.value
  const to =
    event.key === 'ArrowLeft'
      ? Math.max(0, from - 1)
      : event.key === 'ArrowRight'
        ? Math.min(last.value, from + 1)
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? last.value
            : undefined
  if (event.key === 'Escape') emit('inspect', undefined)
  else if (to !== undefined) {
    event.preventDefault()
    emit('inspect', props.trend.points[to]!.id)
  }
}
</script>

<template>
  <article class="trend">
    <header class="head">
      <h3 class="label">{{ trend.label }}</h3>
      <p class="value">{{ formatCount(shown.value) }}</p>
      <p class="meta">
        <time v-if="active >= 0" :datetime="new Date(shown.at).toISOString()">{{
          date(new Date(shown.at).toISOString())
        }}</time><template v-else
          >期间 {{ formatChange(change(trend)) }}</template
        >
      </p>
    </header>
    <div
      ref="plot"
      class="plot"
      tabindex="0"
      :aria-label="`${trend.label}趋势，左右方向键查看每次抓取`"
      @pointerdown="pick"
      @pointermove="move"
      @pointerleave="leave"
      @pointercancel="emit('inspect', undefined)"
      @keydown="key"
    >
      <svg
        :width="box.width"
        :height="box.height"
        :viewBox="`0 0 ${box.width} ${box.height}`"
        aria-hidden="true"
      >
        <g class="grid">
          <line
            v-for="tick in shape.ticks"
            :key="tick.value"
            :x1="box.left"
            :x2="box.right"
            :y1="tick.y"
            :y2="tick.y"
          />
        </g>
        <g class="axis">
          <text
            v-for="tick in shape.ticks"
            :key="tick.value"
            :x="box.width"
            :y="tick.y"
            text-anchor="end"
            dominant-baseline="middle"
          >
            {{ tick.label }}
          </text>
          <text :x="box.left" :y="box.height - 4">{{ shape.start }}</text>
          <text :x="box.right" :y="box.height - 4" text-anchor="end">
            {{ shape.end }}
          </text>
        </g>
        <line
          v-if="active >= 0"
          class="crosshair"
          :x1="shape.xs[active]"
          :x2="shape.xs[active]"
          :y1="box.top - 4"
          :y2="box.bottom"
        />
        <path class="line" :d="shape.path" />
        <template v-if="dots">
          <circle
            v-for="(x, i) in shape.xs"
            :key="trend.points[i]!.id"
            class="dot"
            :cx="x"
            :cy="shape.ys[i]"
            r="4"
          />
        </template>
        <circle
          class="dot end"
          :class="{ on: active >= 0 }"
          :cx="shape.xs[active < 0 ? last : active]"
          :cy="shape.ys[active < 0 ? last : active]"
          r="4"
        />
      </svg>
    </div>
  </article>
</template>

<style scoped>
.trend {
  /* Categorical slot 1, stepped for each surface; the line is the only
     coloured mark, and text keeps the text tokens. */
  --series: #2a78d6;
  padding: 12px var(--inset) 8px;
  background: var(--card);
  border-radius: var(--radius);
  min-width: 0;
}
:root[data-theme='dark'] .trend {
  --series: #3987e5;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) .trend {
    --series: #3987e5;
  }
}
.head {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: baseline;
  column-gap: 12px;
}
.label {
  margin: 0;
  font-size: 15px;
  font-weight: 400;
  color: var(--subtle);
}
.value {
  grid-row: 1 / span 2;
  grid-column: 2;
  align-self: center;
  margin: 0;
  font-size: 22px;
  font-weight: 600;
  line-height: 1.2;
}
.meta {
  margin: 0;
  font-size: 13px;
  color: var(--subtle);
  font-variant-numeric: tabular-nums;
}
.plot {
  margin: 8px calc(var(--inset) * -1 + 4px) 0 0;
  /* Vertical swipes scroll the page; horizontal ones inspect. */
  touch-action: pan-y;
  cursor: crosshair;
  user-select: none;
  -webkit-user-select: none;
}
.plot:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: 2px;
  border-radius: 6px;
}
svg {
  display: block;
  overflow: visible;
}
.grid line {
  stroke: var(--separator);
  stroke-width: 1;
  shape-rendering: crispEdges;
}
.axis text {
  fill: var(--subtle);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.crosshair {
  stroke: var(--subtle);
  stroke-width: 1;
  shape-rendering: crispEdges;
}
.line {
  fill: none;
  stroke: var(--series);
  stroke-width: 2;
  stroke-linejoin: round;
  stroke-linecap: round;
}
.dot {
  fill: var(--series);
  stroke: var(--card);
  stroke-width: 2;
}
</style>
