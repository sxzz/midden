<script setup vapor lang="ts">
import { computed, shallowRef, watch } from 'vue'
import {
  call,
  client,
  errorText,
  type RemovalEffect,
  type RemovalTarget,
} from '../api'
import { removalEffectText } from '../presentation'
import ConfirmSheet from './ConfirmSheet.vue'
/**
 * The confirmation of a removal (删除媒体), stating what it does from a dry
 * run before anything is removed.
 */
const props = defineProps<{
  open: boolean
  target: RemovalTarget
  title: string
}>()
const emit = defineEmits<{ removed: [effect: RemovalEffect]; cancel: [] }>()
const effect = shallowRef<RemovalEffect>()
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
        client['media-removals'].preview.$post({ json: props.target }),
      )
      if (current === request) effect.value = result
    } catch (e) {
      if (current === request) error.value = errorText(e)
    }
  },
  { immediate: true },
)
const description = computed(
  () => error.value || (effect.value ? removalEffectText(effect.value) : ''),
)
async function confirm() {
  busy.value = true
  try {
    const result = await call(
      client['media-removals'].$post({ json: props.target }),
    )
    emit('removed', result)
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
    :title="title"
    :description="description"
    confirm-label="删除"
    :busy="busy || !effect?.media"
    @confirm="confirm"
    @cancel="emit('cancel')"
  />
</template>
