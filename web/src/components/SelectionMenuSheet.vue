<script setup vapor lang="ts">
import { computed, shallowRef, watch } from 'vue'
import { call, client } from '../api'
import { can } from '../user'
import ActionMenu from './ui/ActionMenu.vue'
import AppLink from './ui/AppLink.vue'
import type { MenuOpener } from '../action-menu'
/**
 * The 多选 bar's ⋯ menu: comparing the selected accounts' relations, and
 * the removals, each confirmed by its own sheet.
 */
const props = defineProps<{
  open: boolean
  /** How it was opened: a dropdown with a mouse, else a sheet. */
  opener?: MenuOpener
  count: number
  /** The selected accounts' keys, in the list's order. */
  profiles?: string[]
}>()
const emit = defineEmits<{
  /** The link to the comparison navigates: the menu should close. */
  navigate: []
  removeMedia: []
  delete: []
  cancel: []
}>()
/** The selected accounts with relation data, once asked. */
const comparable = shallowRef<string[]>([])
let asked = ''
async function check() {
  const keys = props.profiles ?? []
  const joined = keys.join('\n')
  if (keys.length < 2 || joined === asked) return
  asked = joined
  comparable.value = []
  try {
    const { items } = await call(
      client.collections.perspectives.$get({ query: { rel_of: keys } }),
    )
    if (asked !== joined) return
    const withData = new Set(
      items.filter((item) => !item.no_data).map((item) => item.id),
    )
    comparable.value = keys.filter((key) => withData.has(key))
  } catch {
    asked = ''
  }
}
const left = computed(
  () => (props.profiles?.length ?? 0) - comparable.value.length,
)
watch(
  () => props.open,
  (open) => {
    if (open) void check()
  },
)
</script>

<template>
  <ActionMenu
    v-slot="{ item }"
    :open="open"
    :opener="opener"
    :label="`已选${count}项`"
    @cancel="emit('cancel')"
  >
    <AppLink
      v-if="comparable.length > 1"
      class="action"
      v-bind="item"
      :to="{ name: 'compare', query: { rel_of: comparable } }"
      @navigate="emit('navigate')"
    >
      比较关系<span v-if="left" class="detail"
        >{{ comparable.length }}个账号，{{ left }}个没有关系数据</span
      >
    </AppLink>
    <button
      v-if="can.delete"
      type="button"
      class="action"
      v-bind="item"
      @click="emit('removeMedia')"
    >
      删除媒体
    </button>
    <button
      v-if="can.delete"
      type="button"
      class="action destructive"
      v-bind="item"
      @click="emit('delete')"
    >
      删除
    </button>
  </ActionMenu>
</template>

<style scoped>
.detail {
  display: block;
  margin-top: 2px;
  font-size: 13px;
  font-weight: 400;
  color: var(--subtle);
}
</style>
