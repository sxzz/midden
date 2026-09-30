<script setup vapor lang="ts">
defineProps<{ open?: boolean }>()
</script>

<template>
  <span class="chevron" :class="{ open }" aria-hidden="true">
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M6 9.75 12 15.75 18 9.75" />
    </svg>
  </span>
</template>

<style scoped>
/* A fixed square with padding: rotating inside it can never nudge the arrow
   sideways, so every chevron in the app sits on the same optical centre. */
.chevron {
  display: grid;
  place-items: center;
  flex: none;
  box-sizing: border-box;
  width: 24px;
  height: 24px;
  padding: 2px;
  color: var(--subtle);
  transform-origin: 50% 50%;
  transition: transform 0.15s ease;
}
.chevron.open {
  transform: rotate(180deg);
}
.chevron svg {
  display: block;
  width: 100%;
  height: 100%;
}
@media (prefers-reduced-motion: reduce) {
  .chevron {
    transition: none;
  }
}
</style>
