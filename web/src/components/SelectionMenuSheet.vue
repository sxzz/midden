<script setup vapor lang="ts">
import { computed, shallowRef, useId, useTemplateRef, watch } from 'vue'
import { call, client } from '../api'
/**
 * The 多选 bar's ⋯ menu: comparing the selected accounts' relations, and
 * the removals, each confirmed by its own sheet.
 */
const props = defineProps<{
  open: boolean
  count: number
  /** The selected accounts' keys, in the list's order. */
  profiles?: string[]
}>()
const emit = defineEmits<{
  /** Compare these accounts, the ones with relation data. */
  compare: [keys: string[]]
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
const titleId = useId()
const dialog = useTemplateRef<HTMLDialogElement>('sheet')
watch(
  () => props.open,
  (open) => {
    if (open) {
      dialog.value?.showModal()
      void check()
    } else dialog.value?.close()
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
      <p :id="titleId" class="title">已选 {{ count }} 项</p>
      <button
        v-if="comparable.length > 1"
        type="button"
        class="action"
        @click="emit('compare', comparable)"
      >
        比较关系<span v-if="left" class="detail"
          >{{ comparable.length }} 个账号，{{ left }} 个没有关系数据</span
        >
      </button>
      <button type="button" class="action" @click="emit('removeMedia')">
        删除媒体
      </button>
      <button type="button" class="action destructive" @click="emit('delete')">
        删除
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
}
.action {
  display: block;
  width: 100%;
  min-height: 52px;
  font-size: 17px;
  text-align: center;
  color: var(--link);
  box-shadow: inset 0 1px 0 var(--separator);
}
.detail {
  display: block;
  margin-top: 2px;
  font-size: 13px;
  color: var(--subtle);
}
.destructive {
  color: var(--destructive);
}
.cancel {
  font-weight: 600;
  box-shadow: none;
}
</style>
