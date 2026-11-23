<script setup vapor lang="ts">
import {
  onActivated,
  onDeactivated,
  shallowRef,
  useTemplateRef,
  watchEffect,
} from 'vue'
import ListButton from './ListButton.vue'
import ListSection from './ListSection.vue'

const props = defineProps<{ loading: boolean; error: string }>()
const emit = defineEmits<{ more: [] }>()
const active = shallowRef(true)
onActivated(() => {
  active.value = true
})
onDeactivated(() => {
  active.value = false
})
const sentinel = useTemplateRef<HTMLDivElement>('sentinel')

watchEffect(
  (cleanup) => {
    if (!active.value || !sentinel.value || props.loading || props.error) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (active.value && entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect()
          emit('more')
        }
      },
      { rootMargin: '0px 0px 400px 0px' },
    )
    observer.observe(sentinel.value)
    cleanup(() => observer.disconnect())
  },
  { flush: 'post' },
)
</script>

<template>
  <div ref="sentinel" class="sentinel" aria-hidden="true" />
  <ListSection v-if="error">
    <p class="error" role="alert">{{ error }}</p>
    <ListButton label="重试加载" @select="$emit('more')" />
  </ListSection>
</template>

<style scoped>
.sentinel {
  height: 1px;
}
.error {
  margin: 0;
  padding: 14px var(--inset);
  font-size: 15px;
  line-height: 1.5;
}
</style>
