<script setup vapor lang="ts">
type Layout = 'feed' | 'album'
defineProps<{ modelValue: Layout }>()
const emit = defineEmits<{ 'update:modelValue': [value: Layout] }>()
const options: { value: Layout; label: string }[] = [
  { value: 'feed', label: '信息流' },
  { value: 'album', label: '相册' },
]
</script>

<template>
  <div class="layout-toggle" role="group" aria-label="列表样式">
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      class="option"
      :class="{ on: modelValue === option.value }"
      :aria-pressed="modelValue === option.value"
      @click="emit('update:modelValue', option.value)"
    >
      <svg
        class="icon"
        viewBox="0 0 24 24"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <template v-if="option.value === 'feed'">
          <rect x="3.5" y="4.5" width="17" height="6" rx="1.6" />
          <rect x="3.5" y="13.5" width="17" height="6" rx="1.6" />
        </template>
        <template v-else>
          <rect x="3.5" y="3.5" width="7" height="7" rx="1.4" />
          <rect x="13.5" y="3.5" width="7" height="7" rx="1.4" />
          <rect x="3.5" y="13.5" width="7" height="7" rx="1.4" />
          <rect x="13.5" y="13.5" width="7" height="7" rx="1.4" />
        </template>
      </svg>
      {{ option.label }}
    </button>
  </div>
</template>

<style scoped>
/* A compact segmented control; it sits on the page, above the results. */
.layout-toggle {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border-radius: 999px;
  background: var(--fill);
}
.option {
  position: relative;
  display: flex;
  align-items: center;
  gap: 5px;
  /* The pill is 36px tall, but the tap target stays a full 44px. */
  min-height: 36px;
  padding: 0 13px;
  border-radius: 999px;
  color: var(--subtle);
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
  transition:
    background 160ms ease,
    color 160ms ease;
}
.option::before {
  content: '';
  position: absolute;
  inset-block: -4px;
}
.option.on {
  background: var(--card);
  color: var(--text);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
}
.option:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: 1px;
}
.icon {
  width: 17px;
  height: 17px;
  flex-shrink: 0;
}
</style>
