<script setup vapor lang="ts">
import { can } from '../user'
import ActionMenu from './ui/ActionMenu.vue'
import AppLink from './ui/AppLink.vue'
import type { MenuOpener } from '../action-menu'
defineProps<{
  open: boolean
  /** How it was opened: a dropdown with a mouse, else a sheet. */
  opener?: MenuOpener
  name: string
  /** The record of an update of the folder started here, to link to. */
  progress?: string
  /** Its 定期更新 in short (每天), when it has one. */
  watching?: string
}>()
const emit = defineEmits<{
  update: []
  watch: []
  /** A link here navigates: the menu should close. */
  navigate: []
  share: []
  rename: []
  delete: []
  cancel: []
}>()
</script>

<template>
  <ActionMenu
    v-slot="{ item }"
    :open="open"
    :opener="opener"
    :label="name"
    @cancel="emit('cancel')"
  >
    <template v-if="can.capture">
      <button
        type="button"
        class="action"
        v-bind="item"
        @click="emit('update')"
      >
        更新收藏夹
      </button>
      <AppLink
        v-if="progress"
        class="action"
        v-bind="item"
        :to="{ name: 'capture', params: { id: progress } }"
        @navigate="emit('navigate')"
      >
        查看更新进度
      </AppLink>
      <button type="button" class="action" v-bind="item" @click="emit('watch')">
        {{ watching ? `定期更新 · ${watching}` : '定期更新' }}
      </button>
    </template>
    <button
      v-if="can.share"
      type="button"
      class="action"
      v-bind="item"
      @click="emit('share')"
    >
      公开分享
    </button>
    <button
      v-if="can.organize"
      type="button"
      class="action"
      v-bind="item"
      @click="emit('rename')"
    >
      重命名
    </button>
    <button
      v-if="can.delete"
      type="button"
      class="action destructive"
      v-bind="item"
      @click="emit('delete')"
    >
      删除收藏夹
    </button>
  </ActionMenu>
</template>
