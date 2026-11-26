<script setup vapor lang="ts">
import { computed } from 'vue'
import { dayLabel, usageBars } from '../tokens'

// A token's requests per day, oldest first: one bar a day, as tall as its
// share of the busiest day. Days without any show as a hairline on the
// baseline, so the month's shape reads even when it is mostly empty.
const props = defineProps<{
  days: { day: string; count: number }[]
  /** Pixel size; the bars share the width with 1px gaps. */
  width: number
  height: number
}>()
const GAP = 1
const bars = computed(() => {
  const list = usageBars(props.days)
  const step = props.width / Math.max(1, list.length)
  const w = Math.max(1, step - GAP)
  return list.map((d, i) => {
    const h = d.count ? Math.max(2, d.share * props.height) : 1
    return {
      ...d,
      x: i * step,
      y: props.height - h,
      w,
      h,
      label: `${dayLabel(d.day)} ${d.count} 次`,
    }
  })
})
const total = computed(() => props.days.reduce((n, d) => n + d.count, 0))
</script>

<template>
  <svg
    class="bars"
    :width="width"
    :height="height"
    :viewBox="`0 0 ${width} ${height}`"
    preserveAspectRatio="none"
    role="img"
    :aria-label="`最近 ${days.length} 天 ${total} 次`"
  >
    <rect
      v-for="b in bars"
      :key="b.day"
      :class="{ empty: !b.count }"
      :x="b.x"
      :y="b.y"
      :width="b.w"
      :height="b.h"
      :rx="b.count && b.w >= 4 ? 1.5 : 0"
    >
      <title>{{ b.label }}</title>
    </rect>
  </svg>
</template>

<style scoped>
.bars {
  display: block;
  flex-shrink: 0;
}
rect {
  fill: var(--link);
}
rect.empty {
  fill: var(--separator);
}
</style>
