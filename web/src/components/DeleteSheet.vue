<script setup vapor lang="ts">
import { computed, shallowRef, watch } from 'vue'
import { call, client, errorText } from '../api'
import { deletionSummary, type DeleteCounts } from '../deletion'
import ConfirmSheet from './ConfirmSheet.vue'
const props = defineProps<{
  open: boolean
  /** Saved collections to delete. */
  ids: string[]
  title: string
}>()
const emit = defineEmits<{
  /** Deleted; `withPosts` when the accounts' posts went too. */
  deleted: [withPosts: boolean]
  cancel: []
}>()
const counts = shallowRef<DeleteCounts>()
const error = shallowRef('')
const busy = shallowRef(false)
/** Unchecked on every opening: removing posts is the larger step. */
const withPosts = shallowRef(false)
const request = (posts: boolean, dryRun: boolean) => {
  const json = { ids: props.ids, with_posts: posts }
  return call(
    dryRun
      ? client.collections.delete.preview.$post({ json })
      : client.collections.delete.$post({ json }),
  )
}
let opened = 0
watch(
  () => props.open,
  async (open) => {
    const version = ++opened
    counts.value = undefined
    error.value = ''
    withPosts.value = false
    if (!open) return
    try {
      // Counted with the posts once: the option only adds them to the total.
      const value = await request(true, true)
      if (version === opened) counts.value = value
    } catch (e) {
      if (version === opened) error.value = errorText(e)
    }
  },
  { immediate: true },
)
const description = computed(
  () =>
    error.value ||
    (counts.value ? deletionSummary(counts.value, withPosts.value) : ''),
)
async function confirm() {
  busy.value = true
  error.value = ''
  try {
    await request(withPosts.value, false)
    emit('deleted', withPosts.value)
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
    :busy="busy || !counts"
    @confirm="confirm"
    @cancel="emit('cancel')"
  >
    <label v-if="counts?.profiles" class="option"
      ><input v-model="withPosts" type="checkbox" :disabled="busy" /><span
        >同时删除关联的帖子</span
      ></label
    >
  </ConfirmSheet>
</template>

<style scoped>
.option {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 0 16px 16px;
  font-size: 15px;
}
.option input {
  width: 20px;
  height: 20px;
  accent-color: var(--destructive);
}
</style>
