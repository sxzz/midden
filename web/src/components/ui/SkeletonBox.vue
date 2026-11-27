<script setup vapor lang="ts">
// A block still loading where a chart, a picture or a card will be, the
// size it will have. Shown only after a moment, as SkeletonRows.
withDefaults(
  defineProps<{ height: string; width?: string; round?: boolean }>(),
  { width: '100%' },
)
</script>

<template>
  <span
    class="skeleton skeleton-box skeleton-delayed"
    :class="{ round }"
    :style="{ width, height }"
    aria-hidden="true"
  />
</template>

<style scoped>
.skeleton-box {
  display: block;
  border-radius: var(--radius);
}
.round {
  border-radius: 50%;
}
</style>
