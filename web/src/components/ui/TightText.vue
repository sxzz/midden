<script setup vapor lang="ts">
import { computed } from 'vue'
import { tightParts } from '../../presentation'
// Text that may hold hashtags and mentions: each `#tag` and `@name` is kept
// tight, with no autospace gap after its # or @ (style.css, `.tight`), while
// the rest of the text keeps the browser's spacing.
const props = defineProps<{ text: string }>()
const parts = computed(() => tightParts(props.text))
</script>

<template>
  <template v-for="(part, index) in parts" :key="index"
    ><span v-if="part.tight" class="tight">{{ part.text }}</span
    ><template v-else>{{ part.text }}</template></template
  >
</template>
