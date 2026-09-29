<script setup vapor lang="ts">
import { useTemplateRef, watch } from "vue";
const props = defineProps<{
  open: boolean;
  title: string;
  description?: string;
  confirmLabel: string;
  busy?: boolean;
}>();
const emit = defineEmits<{ confirm: []; cancel: [] }>();
const dialog = useTemplateRef<HTMLDialogElement>("sheet");
watch(
  () => props.open,
  (open) => {
    if (open) dialog.value?.showModal();
    else dialog.value?.close();
  },
);
function backdrop(event: MouseEvent) {
  if (event.target === dialog.value) emit("cancel");
}
</script>
<template>
  <dialog
    ref="sheet"
    class="sheet"
    aria-labelledby="confirm-title"
    @click="backdrop"
    @cancel.prevent="$emit('cancel')"
  >
    <div class="group">
      <p class="head">
        <strong id="confirm-title">{{ title }}</strong
        ><span v-if="description">{{ description }}</span>
      </p>
      <button
        type="button"
        class="action destructive"
        :disabled="busy"
        @click="$emit('confirm')"
      >
        {{ confirmLabel }}
      </button>
    </div>
    <button type="button" class="group action cancel" @click="$emit('cancel')">
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
.head {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 16px;
  text-align: center;
  font-size: 14px;
  line-height: 1.5;
  color: var(--subtle);
}
.head strong {
  font-size: 16px;
  color: var(--text);
}
.action {
  display: block;
  width: 100%;
  min-height: 52px;
  font-size: 17px;
  text-align: center;
  box-shadow: inset 0 1px 0 var(--separator);
}
.destructive {
  color: var(--destructive);
}
.cancel {
  color: var(--link);
  font-weight: 600;
  box-shadow: none;
}
</style>
