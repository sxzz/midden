<script setup vapor lang="ts">
import { shallowRef, watch } from 'vue'
import { errorText } from '../api'
import { toast } from '../composables/useToast'
import { currentUser, saveNickname } from '../user'
import FolderNameSheet from './FolderNameSheet.vue'

// The signed-in user's own nickname, which everyone else sees; from the
// rail's menu and 设置 → 账号.
const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ done: [] }>()
const busy = shallowRef(false)
const error = shallowRef('')
watch(
  () => props.open,
  () => (error.value = ''),
)
async function save(name: string) {
  if (busy.value) return
  busy.value = true
  try {
    await saveNickname(name)
    toast('已保存昵称')
    emit('done')
  } catch (e) {
    error.value = errorText(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <FolderNameSheet
    :open="open"
    title="昵称"
    confirm-label="保存"
    label="昵称"
    placeholder="昵称"
    :maxlength="32"
    :name="currentUser().name"
    :busy="busy"
    :error="error"
    @submit="save"
    @cancel="emit('done')"
  />
</template>
