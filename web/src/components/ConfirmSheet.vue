<script setup vapor lang="ts">
import { computed, shallowRef, watch } from 'vue'
import SheetDialog from './ui/SheetDialog.vue'
const props = defineProps<{
  open: boolean
  title: string
  description?: string
  confirmLabel: string
  busy?: boolean
  /** For what cannot be undone: the phrase to type before confirming. */
  phrase?: string
}>()
const emit = defineEmits<{ confirm: []; cancel: [] }>()
watch(
  () => props.open,
  () => (typed.value = ''),
)
const typed = shallowRef('')
const ready = computed(
  () => !props.phrase || typed.value.trim() === props.phrase,
)
</script>

<template>
  <SheetDialog
    :open="open"
    :title="title"
    :description="description"
    :dirty="!!typed"
    @cancel="emit('cancel')"
  >
    <!-- Options of the action, between its description and the button. -->
    <slot />
    <label v-if="phrase" class="phrase">
      <span>输入「{{ phrase }}」以确认</span>
      <input
        v-model="typed"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        :placeholder="phrase"
      />
    </label>
    <template #actions>
      <button
        type="button"
        class="action primary destructive"
        :disabled="busy || !ready"
        @click="ready && emit('confirm')"
      >
        {{ confirmLabel }}
      </button>
    </template>
  </SheetDialog>
</template>

<style scoped>
.phrase {
  display: grid;
  gap: 8px;
  padding: 0 16px 16px;
  font-size: 14px;
  color: var(--subtle);
  text-align: center;
}
.phrase input {
  width: 100%;
  padding: 10px 12px;
  border: 0;
  border-radius: 10px;
  background: var(--fill);
  font-size: 16px;
  text-align: center;
}
@media (min-width: 700px) {
  .phrase {
    padding: 4px 16px;
    text-align: left;
  }
  .phrase input {
    text-align: left;
  }
}
</style>
