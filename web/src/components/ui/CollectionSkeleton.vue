<script setup vapor lang="ts">
withDefaults(defineProps<{ detail?: boolean; rows?: number }>(), { rows: 3 })
</script>

<template>
  <div role="status" aria-label="正在加载收藏" aria-busy="true">
    <div
      v-for="i in detail ? 1 : rows"
      :key="i"
      class="placeholder"
      aria-hidden="true"
    >
      <div class="identity">
        <span class="skeleton avatar" /><span class="lines"
          ><span class="skeleton short" /><span class="skeleton"
        /></span>
      </div>
      <span class="skeleton line" /><span class="skeleton line" />
      <span v-if="detail" class="skeleton media" />
    </div>
  </div>
</template>

<style scoped>
.placeholder {
  padding: 16px var(--inset);
}
.placeholder + .placeholder {
  border-top: 1px solid var(--separator);
}
.identity {
  display: flex;
  gap: 12px;
  margin-bottom: 14px;
  align-items: center;
}
.avatar {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  flex-shrink: 0;
}
.lines {
  display: grid;
  gap: 9px;
  width: 60%;
}
.lines .skeleton,
.line {
  display: block;
  height: 12px;
  border-radius: 4px;
}
.short {
  width: 60%;
}
.line {
  margin-top: 10px;
}
.line:last-child {
  width: 75%;
}
.media {
  display: block;
  height: 240px;
  margin-top: 16px;
  border-radius: 8px;
}
</style>
