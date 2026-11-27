<script setup vapor lang="ts">
// A query, or a term of one, coloured by its grammar (`highlight`): keys
// and `#` in the accent colour, their values grey, operators apart.
import { computed } from 'vue'
import { highlight } from '../query'
const props = defineProps<{ text: string }>()
const tokens = computed(() => highlight(props.text))
</script>

<template>
  <code class="query-term"
    ><span
      v-for="(token, i) in tokens"
      :key="i"
      :class="`token-${token.kind}`"
      >{{ token.text }}</span
    ></code
  >
</template>

<style scoped>
.query-term {
  font-family: var(--mono, ui-monospace, 'SF Mono', Menlo, monospace);
  font-size: 0.92em;
  white-space: pre;
}
.token-key {
  color: var(--link);
}
.token-value {
  color: var(--subtle);
}
.token-op {
  color: color-mix(in srgb, var(--destructive) 75%, var(--text));
  font-weight: 600;
}
.token-word {
  color: var(--text);
}
</style>
