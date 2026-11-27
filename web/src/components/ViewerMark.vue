<script setup vapor lang="ts">
import { viewerLabels, type ViewerRelation } from '../graph'
// The viewer's badge on an avatar in lists and cards, drawn as the graph
// draws it: a heart for a mutual follow, a check when the viewer follows,
// an outlined dot when the account follows the viewer.
defineProps<{ relation: ViewerRelation }>()
</script>

<template>
  <span
    class="viewer-mark"
    :class="relation"
    role="img"
    :aria-label="viewerLabels[relation]"
  >
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path
        v-if="relation === 'mutual'"
        class="glyph-fill"
        d="M10 15.1C6.4 12.2 4.4 10.3 4.4 8.1c0-1.7 1.3-3 2.9-3 1.1 0 2.1.6 2.7 1.5.6-.9 1.6-1.5 2.7-1.5 1.6 0 2.9 1.3 2.9 3 0 2.2-2 4.1-5.6 7z"
      />
      <path
        v-else-if="relation === 'following'"
        class="glyph-stroke"
        d="M5.6 10.2 8.6 13.2 14.4 6.8"
      />
      <circle v-else class="dot" cx="10" cy="10" r="3.2" />
    </svg>
  </span>
</template>

<style scoped>
.viewer-mark {
  --mark: #d6336c;
  display: inline-grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--mark);
  box-shadow: 0 0 0 2px var(--card);
}
:root.dark .viewer-mark {
  --mark: #ff6b9a;
}
.viewer-mark.follower {
  background: var(--card);
  box-shadow:
    inset 0 0 0 2px var(--mark),
    0 0 0 2px var(--card);
}
svg {
  width: 100%;
  height: 100%;
}
.glyph-fill {
  fill: var(--card);
}
.glyph-stroke {
  fill: none;
  stroke: var(--card);
  stroke-width: 2.4;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.dot {
  fill: var(--mark);
}
</style>
