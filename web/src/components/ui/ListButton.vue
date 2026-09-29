<script setup vapor lang="ts">
withDefaults(
  defineProps<{
    label: string;
    hint?: string;
    trailing?: string;
    href?: string;
    chevron?: boolean;
    disabled?: boolean;
    variant?: "link" | "plain" | "destructive";
  }>(),
  { variant: "link" },
);
defineEmits<{ select: [] }>();
</script>
<template>
  <a
    v-if="href"
    class="row link"
    :href="href"
    target="_blank"
    rel="noopener noreferrer"
  >
    <span class="label">{{ label }}</span>
    <span class="trailing" aria-hidden="true">↗</span>
  </a>
  <button
    v-else
    type="button"
    class="row"
    :class="variant"
    :disabled="disabled"
    @click="$emit('select')"
  >
    <span class="label"
      >{{ label }}<small v-if="hint" class="hint">{{ hint }}</small></span
    ><span v-if="trailing" class="trailing">{{ trailing }}</span
    ><span v-else-if="chevron" class="trailing chevron" aria-hidden="true"
      >›</span
    >
  </button>
</template>
<style scoped>
.row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-height: 48px;
  padding: 11px var(--inset);
  background: none;
  font-size: 16px;
  color: var(--link);
}
.row + .row::before {
  content: "";
  position: absolute;
  inset: 0 0 auto var(--inset);
  height: 1px;
  background: var(--separator);
}
.row.plain {
  color: var(--text);
}
.row.destructive {
  color: var(--destructive);
}
.row:active:not(:disabled) {
  background: var(--fill);
}
.label {
  flex: 1;
  min-width: 0;
}
.hint {
  display: block;
  font-size: 13px;
  color: var(--subtle);
}
.trailing {
  flex-shrink: 0;
  font-size: 15px;
  color: var(--subtle);
}
.chevron {
  font-size: 22px;
  line-height: 1;
  opacity: 0.55;
}
</style>
