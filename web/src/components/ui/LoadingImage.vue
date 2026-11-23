<script setup vapor lang="ts">
import { shallowRef, watch } from 'vue'
const props = withDefaults(
  defineProps<{ src: string; alt: string; loading?: 'lazy' | 'eager' }>(),
  { loading: 'lazy' },
)
const state = shallowRef<'loading' | 'ready' | 'error'>('loading')
watch(
  () => props.src,
  () => {
    state.value = 'loading'
  },
)
</script>

<template>
  <span
    class="image-shell"
    :class="{ skeleton: state === 'loading' }"
    :aria-busy="state === 'loading'"
  >
    <img
      :key="src"
      :src="src"
      :alt="alt"
      :loading="loading"
      :fetchpriority="loading === 'lazy' ? 'low' : undefined"
      decoding="async"
      :class="{ pending: state !== 'ready' }"
      @load="state = 'ready'"
      @error="state = 'error'"
    />
    <span v-if="state === 'error'" class="image-error" role="status"
      >图片加载失败</span
    >
  </span>
</template>

<style scoped>
.image-shell {
  position: relative;
  display: block;
  overflow: hidden;
  border-radius: inherit;
  background: var(--fill);
}
.image-shell img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: inherit;
  border-radius: inherit;
}
.image-shell {
  min-height: 80px;
}
.image-shell img.pending {
  opacity: 0;
}
.image-error {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 8px;
  font-size: 12px;
  color: var(--subtle);
}
</style>
