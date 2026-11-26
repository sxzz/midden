<script setup vapor lang="ts">
import { useId, useTemplateRef, watch } from 'vue'
import AppLink from './ui/AppLink.vue'
const props = defineProps<{
  open: boolean
  name: string
  /** The record of an update of the folder started here, to link to. */
  progress?: string
  /** Its 定期更新 in short (每天), when it has one. */
  watching?: string
}>()
const emit = defineEmits<{
  update: []
  watch: []
  /** A link here navigates: the sheet should close. */
  navigate: []
  share: []
  rename: []
  delete: []
  cancel: []
}>()
const titleId = useId()
const dialog = useTemplateRef<HTMLDialogElement>('sheet')
watch(
  () => props.open,
  (open) => {
    if (open) dialog.value?.showModal()
    else dialog.value?.close()
  },
)
function backdrop(event: MouseEvent) {
  if (event.target === dialog.value) emit('cancel')
}
</script>

<template>
  <dialog
    ref="sheet"
    class="sheet"
    :aria-labelledby="titleId"
    @click="backdrop"
    @cancel.prevent="emit('cancel')"
  >
    <div class="group">
      <p :id="titleId" class="title">{{ name }}</p>
      <button type="button" class="action" @click="emit('update')">
        更新收藏夹
      </button>
      <AppLink
        v-if="progress"
        class="action"
        :to="{ name: 'capture', params: { id: progress } }"
        @navigate="emit('navigate')"
      >
        查看更新进度
      </AppLink>
      <button type="button" class="action" @click="emit('watch')">
        {{ watching ? `定期更新 · ${watching}` : '定期更新' }}
      </button>
      <button type="button" class="action" @click="emit('share')">
        公开分享
      </button>
      <button type="button" class="action" @click="emit('rename')">
        重命名
      </button>
      <button type="button" class="action destructive" @click="emit('delete')">
        删除收藏夹
      </button>
    </div>
    <button type="button" class="group action cancel" @click="emit('cancel')">
      取消
    </button>
  </dialog>
</template>

<style scoped>
.sheet {
  width: 100%;
  max-width: 480px;
  margin: auto auto 0;
  padding: 0 8px max(8px, env(safe-area-inset-bottom));
  border: 0;
  background: none;
  color: var(--text);
}
.sheet:not([open]) {
  display: none;
}
.sheet::backdrop {
  background: rgba(0, 0, 0, 0.4);
}
.group {
  width: 100%;
  margin-top: 8px;
  border-radius: 14px;
  background: var(--card);
  overflow: hidden;
}
.title {
  margin: 0;
  padding: 14px 16px;
  text-align: center;
  font-size: 14px;
  line-height: 1.5;
  color: var(--subtle);
  overflow-wrap: anywhere;
}
.action {
  display: grid;
  place-items: center;
  width: 100%;
  min-height: 52px;
  font-size: 17px;
  text-align: center;
  color: var(--link);
  box-shadow: inset 0 1px 0 var(--separator);
}
.destructive {
  color: var(--destructive);
}
.cancel {
  font-weight: 600;
  box-shadow: none;
}
</style>
