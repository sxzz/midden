<script setup vapor lang="ts">
import { computed, shallowRef, useId, useTemplateRef, watch } from 'vue'
import { call, client, errorText, type Share } from '../api'
import { toast } from '../composables/useToast'
import { shareURL } from '../share'
const props = defineProps<{
  open: boolean
  target: 'folder' | 'collection'
  id: string
  title: string
}>()
const emit = defineEmits<{ changed: []; cancel: [] }>()
const titleId = useId()
const dialog = useTemplateRef<HTMLDialogElement>('sheet')
const field = useTemplateRef<HTMLInputElement>('field')
const share = shallowRef<Share>()
const loading = shallowRef(false)
const busy = shallowRef(false)
const error = shallowRef('')
const link = computed(() => (share.value ? shareURL(share.value.slug) : ''))
async function load() {
  loading.value = true
  error.value = ''
  share.value = undefined
  try {
    const all = await call(client.shares.$get({ query: {} }))
    share.value = all.find(
      (s) => s.target === props.target && s.target_id === props.id,
    )
  } catch (e) {
    error.value = errorText(e)
  } finally {
    loading.value = false
  }
}
watch(
  () => props.open,
  (open) => {
    if (open) {
      void load()
      dialog.value?.showModal()
    } else dialog.value?.close()
  },
)
async function create() {
  busy.value = true
  error.value = ''
  try {
    share.value = await call(
      client.shares.$post({ json: { target: props.target, id: props.id } }),
    )
    emit('changed')
  } catch (e) {
    error.value = errorText(e)
  } finally {
    busy.value = false
  }
}
async function revoke() {
  const current = share.value
  if (!current) return
  busy.value = true
  error.value = ''
  try {
    await call(client.shares[':id'].$delete({ param: { id: current.id } }))
    share.value = undefined
    toast('已取消公开')
    emit('changed')
  } catch (e) {
    error.value = errorText(e)
  } finally {
    busy.value = false
  }
}
async function copy() {
  try {
    await navigator.clipboard.writeText(link.value)
    toast('已复制链接')
  } catch {
    // Some web views refuse the clipboard; leave the link selected instead.
    field.value?.select()
    toast('请手动复制链接')
  }
}
function backdrop(event: MouseEvent) {
  if (event.target === dialog.value && !busy.value) emit('cancel')
}
</script>

<template>
  <dialog
    ref="sheet"
    class="sheet"
    :aria-labelledby="titleId"
    @click="backdrop"
    @cancel.prevent="busy || emit('cancel')"
  >
    <div class="group">
      <p class="head">
        <strong :id="titleId">{{ title }}</strong><span
          >任何拿到链接的人都能查看，无需登录。</span
        >
      </p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <template v-if="share">
        <div class="field">
          <input
            ref="field"
            :value="link"
            aria-label="公开链接"
            readonly
            @focus="($event.target as HTMLInputElement).select()"
          />
        </div>
        <button type="button" class="action" :disabled="busy" @click="copy">
          复制链接
        </button>
        <button
          type="button"
          class="action destructive"
          :disabled="busy"
          @click="revoke"
        >
          取消公开
        </button>
      </template>
      <button
        v-else
        type="button"
        class="action"
        :disabled="busy || loading"
        @click="create"
      >
        创建公开链接
      </button>
    </div>
    <button
      type="button"
      class="group action cancel"
      :disabled="busy"
      @click="emit('cancel')"
    >
      完成
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
  overflow-wrap: anywhere;
}
.head strong {
  font-size: 16px;
  color: var(--text);
}
.field {
  display: block;
  padding: 0 16px 16px;
}
.field input {
  width: 100%;
  padding: 10px 12px;
  border: 0;
  border-radius: 10px;
  background: var(--fill);
  font-size: 14px;
  color: var(--text);
  text-overflow: ellipsis;
}
.error {
  margin: 0;
  padding: 0 16px 12px;
  font-size: 14px;
  line-height: 1.5;
  text-align: center;
  color: var(--destructive);
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
.action:disabled {
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
