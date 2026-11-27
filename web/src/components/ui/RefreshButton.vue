<script setup vapor lang="ts">
// 刷新: read what a view shows again, with the filters it has. What is on
// screen stays while the new read runs (stale-while-revalidate); only the
// button turns, so nothing flashes and the scroll position holds. An icon
// alone (its name in aria-label and the tooltip), last in its toolbar:
// right of the layout switcher where there is one.
const props = defineProps<{ busy?: boolean }>()
const emit = defineEmits<{ refresh: [] }>()
function click() {
  if (!props.busy) emit('refresh')
}
</script>

<template>
  <button
    type="button"
    class="refresh"
    aria-label="刷新"
    title="刷新"
    :aria-busy="busy ? 'true' : 'false'"
    :aria-disabled="busy ? 'true' : undefined"
    @click="click"
  >
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      :class="{ turning: busy }"
    >
      <path d="M20 12a8 8 0 1 1-2.34-5.66" />
      <path d="M20 4v5h-5" />
    </svg>
  </button>
</template>

<style scoped>
.refresh {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  color: var(--link);
  transition: background 120ms ease;
}
.refresh:hover:not([aria-busy='true']) {
  background: var(--fill);
}
/* Busy: grey and not clickable. Not `disabled`, which would drop the focus
   of a keyboard that pressed it. Without motion this is all it shows. */
.refresh[aria-busy='true'] {
  color: var(--subtle);
  cursor: progress;
}
.turning {
  animation: turn 0.9s linear infinite;
}
@keyframes turn {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .turning {
    animation: none;
  }
  .refresh {
    transition: none;
  }
}
</style>
