<script setup vapor lang="ts">
import { computed, shallowRef, watch } from 'vue'
import {
  call,
  client,
  errorText,
  type VideoRemoval,
  type VideoRemovalEffect,
} from '../api'
import { videoRemovalSummary } from '../deletion'
import ConfirmSheet from './ConfirmSheet.vue'
/**
 * The confirmation of 删除所有视频 of a profile, stating what it does from a
 * dry run; confirming starts the job that removes them.
 */
const props = defineProps<{
  open: boolean
  /** The profile. */
  id: string
}>()
const emit = defineEmits<{ started: [removal: VideoRemoval]; cancel: [] }>()
const removal = client.collections[':id']['video-removal']
const effect = shallowRef<VideoRemovalEffect>()
const error = shallowRef('')
const busy = shallowRef(false)
let request = 0
watch(
  () => props.open,
  async (open) => {
    const current = ++request
    effect.value = undefined
    error.value = ''
    if (!open) return
    try {
      const result = await call(
        removal.preview.$post({ param: { id: props.id } }),
      )
      if (current === request) effect.value = result
    } catch (e) {
      if (current === request) error.value = errorText(e)
    }
  },
  { immediate: true },
)
const description = computed(
  () => error.value || (effect.value ? videoRemovalSummary(effect.value) : ''),
)
async function confirm() {
  busy.value = true
  try {
    const started = await removal.$post({ param: { id: props.id } })
    emit('started', await call(started))
  } catch (e) {
    error.value = errorText(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <ConfirmSheet
    :open="open"
    title="删除所有视频？"
    :description="description"
    confirm-label="删除"
    :busy="busy || !effect?.videos"
    @confirm="confirm"
    @cancel="emit('cancel')"
  />
</template>
