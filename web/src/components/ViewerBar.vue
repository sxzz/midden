<script setup vapor lang="ts">
import { computed } from 'vue'
import { listsText } from '../graph'
import { perspectiveName } from '../relation-filter'
import PerspectivePicker from './PerspectivePicker.vue'
import ViewerMark from './ViewerMark.vue'
import type { FollowGraph } from '../api'
// Whose follows mark a graph: the account picked, and once any account is
// marked, a chip that fades the rest and how far its lists were read.
const props = defineProps<{
  /** The chosen account's key, or ''. */
  viewer: string
  /** What the graph said about it. */
  info?: FollowGraph['viewer']
  /** How many accounts shown it relates to. */
  marked: number
}>()
const dim = defineModel<boolean>('dim', { required: true })
const emit = defineEmits<{ change: [key: string] }>()
const chosen = computed({
  get: () => (props.viewer ? [props.viewer] : []),
  set: (value: string[]) => emit('change', value[0] ?? ''),
})
const name = computed(() =>
  props.viewer ? perspectiveName(props.viewer, props.info) : '',
)
const lists = computed(() =>
  props.info ? `${name.value} ${listsText(props.info.lists)}` : '',
)
</script>

<template>
  <div class="viewer-bar">
    <div class="picker">
      <PerspectivePicker v-model="chosen" label="标记账号" single empty="无" />
    </div>
    <template v-if="viewer && marked">
      <button
        type="button"
        class="chip"
        :class="{ on: dim }"
        :aria-pressed="dim"
        @click="dim = !dim"
      >
        <ViewerMark relation="mutual" />与 {{ name }} 的关系<span
          class="count"
          >{{ marked }}</span
        >
      </button>
      <p class="lists">{{ lists }}</p>
    </template>
  </div>
</template>

<style scoped>
.viewer-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
  margin-top: 8px;
}
.picker {
  flex: 1 1 220px;
  min-width: 0;
  border-radius: var(--radius);
  background: var(--card);
  overflow: hidden;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 34px;
  padding: 0 12px 0 8px;
  border-radius: 17px;
  background: var(--card);
  color: var(--subtle);
  font-size: 14px;
  box-shadow: inset 0 0 0 1px var(--separator);
}
.chip.on {
  color: var(--text);
  box-shadow: inset 0 0 0 1.5px currentColor;
}
.chip:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: 2px;
}
.chip :deep(.viewer-mark) {
  width: 16px;
  height: 16px;
  box-shadow: none;
}
.count {
  color: var(--subtle);
  font-variant-numeric: tabular-nums;
}
.lists {
  flex-basis: 100%;
  margin: 0 4px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--subtle);
}
</style>
