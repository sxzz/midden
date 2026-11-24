<script setup vapor lang="ts">
import { shallowRef } from 'vue'
import type { GraphNodeView } from '../graph'
// A small round avatar of an account in a comparison: its picture, or its
// initial when it has none, is sensitive, or fails to load.
defineProps<{ view: GraphNodeView; size?: number }>()
const broken = shallowRef(false)
</script>

<template>
  <span
    class="mini-avatar"
    :style="{ '--size': `${size ?? 20}px` }"
    :title="view.label"
  >
    <img
      v-if="view.image && !broken"
      :src="view.image"
      alt=""
      loading="lazy"
      decoding="async"
      referrerpolicy="no-referrer"
      @error="broken = true"
    />
    <span v-else class="initial" aria-hidden="true">{{ view.initial }}</span>
  </span>
</template>

<style scoped>
.mini-avatar {
  flex: none;
  display: inline-grid;
  place-items: center;
  width: var(--size);
  height: var(--size);
  border-radius: 50%;
  overflow: hidden;
  background: var(--fill);
  vertical-align: middle;
}
img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.initial {
  font-size: calc(var(--size) * 0.45);
  font-weight: 600;
  line-height: 1;
}
</style>
