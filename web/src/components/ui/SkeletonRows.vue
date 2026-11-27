<script setup vapor lang="ts">
// A grouped list still loading: the same card and row heights as ListSection
// with ListButton rows, so nothing moves when the rows arrive. Shown only
// after a moment (`.skeleton-delayed`), so a quick answer shows nothing.
withDefaults(
  defineProps<{
    rows?: number
    /** A bar where the section's title will be. */
    title?: boolean
    /** Rows with a second, smaller line. */
    hint?: boolean
    /** A round picture at the start of each row. */
    avatar?: boolean
    label?: string
  }>(),
  { rows: 3, label: '正在读取' },
)
// Rows of different lengths read as text, not as a striped block.
const WIDTHS = ['62%', '44%', '54%', '36%']
</script>

<template>
  <section
    class="skeleton-rows skeleton-delayed"
    role="status"
    aria-busy="true"
    :aria-label="label"
  >
    <span v-if="title" class="skeleton title" aria-hidden="true" />
    <div class="card" aria-hidden="true">
      <div v-for="i in rows" :key="i" class="row" :class="{ hint }">
        <span v-if="avatar" class="skeleton avatar" />
        <span class="lines">
          <span class="skeleton bar" :style="{ width: WIDTHS[i % 4] }" />
          <span v-if="hint" class="skeleton bar small" />
        </span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.skeleton-rows {
  margin: 0 0 22px;
}
.title {
  display: block;
  width: 72px;
  height: 13px;
  margin: 3px calc(var(--gutter) + 4px) 11px;
  border-radius: 4px;
}
.card {
  margin: 0 var(--gutter);
  overflow: hidden;
  border-radius: var(--radius);
  background: var(--card);
}
.row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 48px;
  padding: 11px var(--inset);
}
.row.hint {
  min-height: 62px;
}
.row + .row::before {
  content: '';
  position: absolute;
  inset: 0 0 auto var(--inset);
  height: 1px;
  background: var(--separator);
}
.avatar {
  flex: none;
  width: 36px;
  height: 36px;
  border-radius: 50%;
}
.lines {
  display: grid;
  flex: 1;
  gap: 8px;
}
.bar {
  display: block;
  height: 13px;
  border-radius: 4px;
}
.bar.small {
  width: 30%;
  height: 10px;
}
</style>
