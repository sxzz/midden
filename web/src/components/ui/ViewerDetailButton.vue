<script setup vapor lang="ts">
import { computed } from 'vue'
import { detailTitles, type DetailKind } from '../../titles'
import AppLink from './AppLink.vue'
// The viewer's link to the post (or account) it shows, an icon in its
// action capsule named as that page is; `navigate` closes the viewer.
const props = defineProps<{ href: string; kind: DetailKind }>()
const label = computed(() => `查看${detailTitles[props.kind]}`)
const emit = defineEmits<{ navigate: [] }>()
</script>

<template>
  <AppLink
    class="detail"
    :href="href"
    :aria-label="label"
    :title="label"
    @navigate="emit('navigate')"
  >
    <svg
      class="icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      stroke-width="1.9"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <rect x="3.6" y="4.4" width="16.8" height="15.2" rx="3" />
      <path d="M7.8 9.2h8.4M7.8 12.8h8.4M7.8 16.4h5" />
    </svg>
  </AppLink>
</template>

<style scoped>
.detail {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  color: #fff;
  transition:
    transform 220ms cubic-bezier(0.32, 0.72, 0, 1),
    background-color 160ms ease;
}
.detail:active {
  background-color: rgba(255, 255, 255, 0.16);
  transform: scale(0.9);
}
.detail:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
}
.icon {
  display: block;
  width: 21px;
  height: 21px;
}
</style>
