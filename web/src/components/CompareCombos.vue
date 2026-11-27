<script setup vapor lang="ts">
import { computed, shallowRef } from 'vue'
import { comboRows } from '../compare'
import { formatCount } from '../trends'
import MiniAvatar from './MiniAvatar.vue'
import type { RelationCompare } from '../api'
import type { GraphNodeView } from '../graph'
// The combination table (UpSet style): each exact subset of the compared
// accounts that has accounts in common, as a row of avatar dots with its
// count, most first. Tapping a row shows only that subset's accounts.
const props = defineProps<{
  data: RelationCompare
  accounts: GraphNodeView[]
  /** The subset shown alone, by its key. */
  selected?: string
}>()
const emit = defineEmits<{ pick: [of: number[] | undefined] }>()
const FIRST = 30
const all = shallowRef(false)
const rows = computed(() => comboRows(props.data))
const shown = computed(() =>
  all.value ? rows.value : rows.value.slice(0, FIRST),
)
const names = (of: number[]) =>
  of.map((i) => props.accounts[i]?.label ?? '').join('、')
</script>

<template>
  <section class="combos" aria-label="组合">
    <ul>
      <li v-for="row in shown" :key="row.key">
        <button
          type="button"
          class="row"
          :class="{ on: row.key === selected }"
          :aria-pressed="row.key === selected"
          :aria-label="`${names(row.of)}：${row.count}`"
          @click="emit('pick', row.key === selected ? undefined : row.of)"
        >
          <span class="dots" aria-hidden="true">
            <template v-for="(account, i) in accounts" :key="account.key">
              <MiniAvatar
                v-if="row.of.includes(i)"
                :view="account"
                :size="20"
              />
              <span v-else class="dot" />
            </template>
          </span>
          <span class="bar" aria-hidden="true"
            ><span :style="{ width: `${Math.max(2, row.share * 100)}%` }"
          /></span>
          <span class="count">{{ formatCount(row.count) }}</span>
        </button>
      </li>
    </ul>
    <button
      v-if="rows.length > FIRST && !all"
      type="button"
      class="all"
      @click="all = true"
    >
      显示全部{{ rows.length }}种组合
    </button>
  </section>
</template>

<style scoped>
.combos {
  border-radius: var(--radius);
  background: var(--card);
  overflow-x: auto;
}
ul {
  margin: 0;
  padding: 4px 0;
  list-style: none;
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 36px;
  padding: 4px var(--inset);
}
.row.on,
.row:active {
  background: var(--fill);
}
.row:focus-visible,
.all:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: -2px;
}
.dots {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
}
.dot {
  display: inline-grid;
  place-items: center;
  width: 20px;
  height: 20px;
}
.dot::after {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--separator);
}
.bar {
  flex: 1;
  min-width: 48px;
  height: 8px;
  border-radius: 4px;
  background: var(--fill);
  overflow: hidden;
}
.bar span {
  display: block;
  height: 100%;
  border-radius: 4px;
  background: var(--link);
}
.count {
  flex: none;
  min-width: 3em;
  font-size: 14px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.all {
  width: 100%;
  min-height: 40px;
  color: var(--link);
  font-size: 14px;
  box-shadow: inset 0 1px 0 var(--separator);
}
</style>
