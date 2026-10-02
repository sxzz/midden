<script setup vapor lang="ts">
defineOptions({ name: 'LockIcon' })
</script>

<template>
  <!-- X's protected-account padlock, drawn in the text colour. -->
  <svg class="lock-icon" viewBox="0 0 24 24" role="img" aria-label="私密">
    <path
      fill="currentColor"
      d="M17.5 7H17v-.25c0-2.76-2.24-5-5-5s-5 2.24-5 5V7h-.5C5.12 7 4 8.12 4 9.5v9C4 19.88 5.12 21 6.5 21h11c1.39 0 2.5-1.12 2.5-2.5v-9C20 8.12 18.89 7 17.5 7zM13 14.73V17h-2v-2.27c-.59-.34-1-.99-1-1.73 0-1.1.9-2 2-2 1.11 0 2 .9 2 2 0 .74-.4 1.39-1 1.73zM15 7H9v-.25c0-1.66 1.34-3 3-3 1.65 0 3 1.34 3 3V7z"
    />
  </svg>
</template>

<style scoped>
.lock-icon {
  flex-shrink: 0;
  width: 1.05em;
  height: 1.05em;
  vertical-align: -0.15em;
}
</style>
