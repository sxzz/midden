<script setup vapor lang="ts">
// 显示敏感内容: the eye that shows or blurs sensitive media everywhere, in a
// page's header or at the right of its tabs; the page styles it.
defineProps<{ pressed: boolean }>()
const emit = defineEmits<{ toggle: [] }>()
</script>

<template>
  <button
    type="button"
    aria-label="显示敏感内容"
    :aria-pressed="pressed"
    :title="pressed ? '隐藏敏感内容' : '显示敏感内容'"
    @click="emit('toggle')"
  >
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
      <path v-if="!pressed" d="m3 3 18 18" />
    </svg>
  </button>
</template>
