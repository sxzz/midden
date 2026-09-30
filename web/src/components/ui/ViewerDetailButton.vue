<script setup vapor lang="ts">
defineEmits<{ select: [] }>()
</script>

<template>
  <button
    type="button"
    class="glass detail"
    aria-label="打开收藏详情"
    title="收藏详情"
    @click="$emit('select')"
  >
    <svg
      class="icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <rect x="3.6" y="4.4" width="16.8" height="15.2" rx="3" />
      <path d="M7.8 9.2h8.4M7.8 12.8h8.4M7.8 16.4h5" />
    </svg>
    <span class="text">收藏详情</span>
  </button>
</template>

<style scoped>
/* Same glass family as the viewer's other chrome buttons. */
.detail {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 44px;
  padding: 0 14px;
  border-radius: 999px;
  color: #fff;
  font-size: 14px;
  font-weight: 500;
  background-color: rgba(18, 18, 20, 0.58);
  background-image: linear-gradient(
    to bottom,
    rgba(255, 255, 255, 0.14),
    rgba(255, 255, 255, 0.02) 48%,
    rgba(255, 255, 255, 0.08)
  );
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.26),
    inset 0 0 0 0.5px rgba(255, 255, 255, 0.1),
    0 8px 28px rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(26px) saturate(180%);
  -webkit-backdrop-filter: blur(26px) saturate(180%);
  -webkit-user-select: none;
  user-select: none;
  transition: transform 220ms cubic-bezier(0.32, 0.72, 0, 1);
}
@supports not (
  (backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))
) {
  .detail {
    background-color: rgba(18, 18, 20, 0.86);
  }
}
.detail:active {
  transform: scale(0.94);
}
.detail:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
}
.icon {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
}
/* On the narrowest phones the icon alone carries it. */
@media (max-width: 360px) {
  .text {
    display: none;
  }
  .detail {
    width: 44px;
    padding: 0;
    justify-content: center;
  }
}
</style>
