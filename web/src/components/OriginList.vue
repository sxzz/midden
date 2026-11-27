<script setup vapor lang="ts">
import { computed, shallowRef } from 'vue'
import { call, client, errorText, type WebOrigin } from '../api'
import { onShown } from '../composables/useShown'
import { toast } from '../composables/useToast'
import { date } from '../presentation'
import ConfirmSheet from './ConfirmSheet.vue'
import FolderNameSheet from './FolderNameSheet.vue'
import ListButton from './ui/ListButton.vue'
import ListSection from './ui/ListSection.vue'
import SkeletonRows from './ui/SkeletonRows.vue'
/** Under a heading of its own (设置's entry), without its title. */
defineProps<{ bare?: boolean }>()

const emit = defineEmits<{
  /** A domain went, and its passkeys with it. */
  removed: []
}>()
const PLACEHOLDER = 'https://example.com'
const items = shallowRef<WebOrigin[]>()
const error = shallowRef('')
const busy = shallowRef(false)
const adding = shallowRef(false)
const addError = shallowRef('')
const removing = shallowRef<WebOrigin>()

async function load() {
  try {
    items.value = await call(client.origins.$get())
    error.value = ''
  } catch (e) {
    error.value = errorText(e)
  }
}
onShown(load)

const hostOf = (o: WebOrigin) => new URL(o.origin).host
const details = (o: WebOrigin) =>
  o.created_at
    ? [
        `添加于 ${date(o.created_at)}`,
        o.passkeys ? `${o.passkeys}个通行密钥` : '',
      ]
        .filter(Boolean)
        .join(' · ')
    : 'Mini App地址'

function openAdd() {
  addError.value = ''
  adding.value = true
}
async function add(origin: string) {
  if (busy.value) return
  busy.value = true
  try {
    const added = await call(client.origins.$post({ json: { origin } }))
    adding.value = false
    toast(`已添加${new URL(added.origin).host}。`)
    await load()
  } catch (e) {
    addError.value = errorText(e)
  } finally {
    busy.value = false
  }
}

const removal = computed(() => {
  const n = removing.value?.passkeys ?? 0
  return n ? `将同时删除此域名的${n}个通行密钥` : undefined
})
async function remove() {
  const o = removing.value
  if (!o?.id || busy.value) return
  busy.value = true
  try {
    await call(client.origins[':id'].$delete({ param: { id: o.id } }))
    removing.value = undefined
    await load()
    emit('removed')
  } catch (e) {
    removing.value = undefined
    toast(errorText(e))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <SkeletonRows
    v-if="!items && !error"
    :title="!bare"
    :rows="2"
    hint
    label="正在读取域名"
  />
  <ListSection v-if="items || error" :title="bare ? undefined : '域名'">
    <p v-if="error" class="banner" role="alert">{{ error }}</p>
    <div v-for="o in items" :key="o.origin" class="origin">
      <span class="label"
        >{{ hostOf(o) }}<small class="hint">{{ details(o) }}</small></span
      >
      <button
        v-if="o.id"
        type="button"
        class="action remove"
        :aria-label="`删除${hostOf(o)}`"
        :disabled="busy"
        @click="removing = o"
      >
        删除
      </button>
    </div>
    <ListButton
      v-if="items"
      label="添加域名"
      :disabled="busy"
      @select="openAdd"
    />
  </ListSection>
  <FolderNameSheet
    :open="adding"
    title="添加域名"
    confirm-label="添加"
    :placeholder="PLACEHOLDER"
    label="地址"
    :maxlength="2048"
    url
    :busy="busy"
    :error="addError"
    @submit="add"
    @cancel="adding = false"
  />
  <ConfirmSheet
    :open="!!removing"
    :title="`删除${removing ? hostOf(removing) : ''}？`"
    :description="removal"
    confirm-label="删除域名"
    :busy="busy"
    @confirm="remove"
    @cancel="removing = undefined"
  />
</template>

<style scoped>
.banner {
  margin: 0;
  padding: 14px var(--inset);
  font-size: 15px;
  line-height: 1.5;
}
.origin {
  position: relative;
  display: flex;
  align-items: center;
  min-height: 56px;
  padding: 0 0 0 var(--inset);
}
.origin + .origin::before,
.origin + :deep(.row)::before {
  content: '';
  position: absolute;
  inset: 0 0 auto var(--inset);
  height: 1px;
  background: var(--separator);
}
.label {
  flex: 1;
  min-width: 0;
  padding: 10px var(--inset) 10px 0;
  font-size: 16px;
  overflow-wrap: anywhere;
}
.hint {
  display: block;
  font-size: 13px;
  line-height: 1.45;
  color: var(--subtle);
}
.action {
  flex-shrink: 0;
  min-height: 48px;
  padding: 0 var(--inset) 0 10px;
  font-size: 15px;
}
.action:active:not(:disabled) {
  background: var(--fill);
}
.remove {
  color: var(--destructive);
}
</style>
