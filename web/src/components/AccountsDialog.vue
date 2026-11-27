<script setup vapor lang="ts">
import AccountsView from './AccountsView.vue'
import SheetDialog from './ui/SheetDialog.vue'
// 采集 → 采集账号: the capture accounts over the records, a sheet from the
// bottom on a phone and a dialog in the middle from 700px (SheetDialog). Its
// address is the tab's own with `?dialog=accounts`, so the bot can link to
// it.
defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <SheetDialog :open="open" title="采集账号" page @cancel="emit('close')">
    <!-- Mounted while open, so each opening reads the accounts again. -->
    <AccountsView v-if="open" />
  </SheetDialog>
</template>
