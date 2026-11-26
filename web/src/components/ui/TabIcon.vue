<script setup vapor lang="ts">
// The navigation's icons, outlined, and bolder or filled for the page shown,
// as X marks the open tab; the bottom bar and the desktop rail share them.
defineProps<{
  name: 'explore' | 'relations' | 'settings' | 'captures'
  active?: boolean
  size?: number
}>()
const GEAR =
  'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z'
// The hole in the filled gear, as a second subpath under even-odd filling.
const HUB = 'M15 12a3 3 0 1 1-6 0a3 3 0 1 1 6 0Z'
</script>

<template>
  <svg
    viewBox="0 0 24 24"
    :width="size ?? 24"
    :height="size ?? 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="active ? 2.4 : 1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    :data-active="active ? '' : undefined"
  >
    <template v-if="name === 'explore'">
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.5 15.5 5 5" />
    </template>
    <template v-else-if="name === 'relations'">
      <path d="M10.8 7.7 6.2 15.8M13.2 7.7l4.6 8.1M7.5 18h9" />
      <g :fill="active ? 'currentColor' : 'none'">
        <circle cx="12" cy="5.5" r="2.5" />
        <circle cx="5" cy="18" r="2.5" />
        <circle cx="19" cy="18" r="2.5" />
      </g>
    </template>
    <template v-else-if="name === 'captures'">
      <path d="M12 4v11" />
      <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
      <path d="M5 20h14" />
    </template>
    <template v-else>
      <path
        v-if="active"
        :d="`${GEAR}${HUB}`"
        fill="currentColor"
        fill-rule="evenodd"
        stroke-width="1.4"
      />
      <template v-else>
        <circle cx="12" cy="12" r="3" />
        <path :d="GEAR" />
      </template>
    </template>
  </svg>
</template>
