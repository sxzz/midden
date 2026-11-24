<script setup vapor lang="ts">
defineProps<{ label: string }>()
</script>

<template>
  <span class="spinner" role="status" :aria-label="label" />
</template>

<style scoped>
.spinner {
  display: inline-block;
  flex: none;
  width: 16px;
  height: 16px;
  border: 2px solid color-mix(in srgb, currentColor 22%, transparent);
  border-top-color: currentColor;
  border-radius: 50%;
  vertical-align: -3px;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .spinner {
    animation-duration: 2.4s;
  }
}
</style>
