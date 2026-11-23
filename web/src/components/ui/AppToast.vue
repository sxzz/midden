<script setup vapor lang="ts">
import { toastState } from '../../composables/useToast'
</script>

<template>
  <div class="toast-region" role="status" aria-live="polite">
    <p v-if="toastState" :key="toastState.id" class="toast">
      {{ toastState.text }}
    </p>
  </div>
</template>

<style scoped>
.toast-region {
  position: fixed;
  inset: auto 0 max(24px, env(safe-area-inset-bottom));
  z-index: 50;
  display: flex;
  justify-content: center;
  padding: 0 var(--gutter);
  pointer-events: none;
}
.toast {
  max-width: 480px;
  margin: 0;
  padding: 10px 16px;
  border-radius: 12px;
  background: rgba(0, 0, 0, 0.82);
  color: #fff;
  font-size: 14px;
  line-height: 1.45;
  text-align: center;
  animation: toast-in 180ms ease-out;
}
@keyframes toast-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
}
@media (prefers-reduced-motion: reduce) {
  .toast {
    animation: none;
  }
}
</style>
