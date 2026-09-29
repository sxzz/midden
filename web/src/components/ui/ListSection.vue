<script setup vapor lang="ts">
defineProps<{ title?: string; footnote?: string; plain?: boolean }>()
</script>

<template>
  <section class="section">
    <h2 v-if="title" class="section-title">{{ title }}</h2>
    <div class="section-body" :class="{ plain }"><slot /></div>
    <p v-if="footnote" class="section-footnote">{{ footnote }}</p>
  </section>
</template>

<style scoped>
.section {
  margin: 0 0 22px;
}
.section-title {
  margin: 0 0 8px;
  padding: 0 calc(var(--gutter) + 4px);
  font-size: 15px;
  font-weight: 600;
  color: var(--subtle);
}
.section-body {
  background: var(--card);
  border-radius: var(--radius);
  margin: 0 var(--gutter);
  overflow: hidden;
}
.section-body.plain {
  background: none;
  border-radius: 0;
  overflow: visible;
}
.section-footnote {
  margin: 8px 0 0;
  padding: 0 calc(var(--gutter) + 4px);
  font-size: 13px;
  line-height: 1.5;
  color: var(--subtle);
}
</style>
