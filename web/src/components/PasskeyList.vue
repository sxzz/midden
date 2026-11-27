<script setup vapor lang="ts">
import { computed, shallowRef } from 'vue'
import { call, client, errorText, type Passkey } from '../api'
import { onShown } from '../composables/useShown'
import { toast } from '../composables/useToast'
import {
  createPasskey,
  defaultPasskeyName,
  passkeyError,
  passkeysSupported,
} from '../passkey'
import { date } from '../presentation'
import ConfirmSheet from './ConfirmSheet.vue'
import FolderNameSheet from './FolderNameSheet.vue'
import ListButton from './ui/ListButton.vue'
import ListSection from './ui/ListSection.vue'
import SkeletonRows from './ui/SkeletonRows.vue'
/** Under a heading of its own (设置's section), without its title. */
defineProps<{ bare?: boolean }>()

const items = shallowRef<Passkey[]>()
const error = shallowRef('')
const busy = shallowRef(false)
const renaming = shallowRef<Passkey>()
const renameError = shallowRef('')
const removing = shallowRef<Passkey>()
const supported = passkeysSupported()

async function load() {
  try {
    items.value = await call(client.passkeys.$get())
    error.value = ''
  } catch (e) {
    error.value = errorText(e)
  }
}
onShown(load)
defineExpose({ load })

const details = (p: Passkey) =>
  [
    p.rp_id,
    `创建于 ${date(p.created_at)}`,
    p.last_used_at ? `上次使用 ${date(p.last_used_at)}` : '',
  ]
    .filter(Boolean)
    .join(' · ')

async function add() {
  if (busy.value) return
  busy.value = true
  try {
    const passkey = await createPasskey(defaultPasskeyName())
    toast(`已添加 ${passkey.name}。`)
    await load()
  } catch (e) {
    const message = passkeyError(e)
    if (message) toast(message)
  } finally {
    busy.value = false
  }
}
function openRename(p: Passkey) {
  renameError.value = ''
  renaming.value = p
}
async function rename(name: string) {
  const p = renaming.value
  if (!p || busy.value) return
  busy.value = true
  try {
    await call(
      client.passkeys[':id'].$patch({ param: { id: p.id }, json: { name } }),
    )
    renaming.value = undefined
    await load()
  } catch (e) {
    renameError.value = errorText(e)
  } finally {
    busy.value = false
  }
}
const last = computed(() => items.value?.length === 1)
// Losing a passkey may mean it was lost: by default the browsers it signed
// in go too, every one but this.
const signOutOthers = shallowRef(true)
function openRemove(p: Passkey) {
  signOutOthers.value = true
  removing.value = p
}
async function remove() {
  const p = removing.value
  if (!p || busy.value) return
  busy.value = true
  try {
    await call(
      client.passkeys[':id'].$delete({
        param: { id: p.id },
        query: signOutOthers.value ? { sign_out_others: 'true' } : {},
      }),
    )
    removing.value = undefined
    await load()
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
    label="正在读取通行密钥"
  />
  <ListSection v-if="items || error" :title="bare ? undefined : '通行密钥'">
    <p v-if="error" class="banner" role="alert">{{ error }}</p>
    <div v-for="p in items" :key="p.id" class="passkey">
      <span class="label"
        >{{ p.name }}<small class="hint">{{ details(p) }}</small></span
      >
      <button
        type="button"
        class="action"
        :aria-label="`重命名 ${p.name}`"
        :disabled="busy"
        @click="openRename(p)"
      >
        重命名
      </button>
      <button
        type="button"
        class="action remove"
        :aria-label="`删除 ${p.name}`"
        :disabled="busy"
        @click="openRemove(p)"
      >
        删除
      </button>
    </div>
    <ListButton
      v-if="supported && items"
      label="添加通行密钥"
      :disabled="busy"
      @select="add"
    />
  </ListSection>
  <FolderNameSheet
    :open="!!renaming"
    title="重命名通行密钥"
    confirm-label="保存"
    placeholder="名称"
    :name="renaming?.name"
    :busy="busy"
    :error="renameError"
    @submit="rename"
    @cancel="renaming = undefined"
  />
  <ConfirmSheet
    :open="!!removing"
    :title="`删除 ${removing?.name ?? ''}？`"
    :description="
      last ? '可以在Telegram中发送 /passkey 添加新的通行密钥。' : undefined
    "
    confirm-label="删除通行密钥"
    :busy="busy"
    @confirm="remove"
    @cancel="removing = undefined"
  >
    <label class="option"
      ><input v-model="signOutOthers" type="checkbox" :disabled="busy" /><span
        >同时退出所有其他设备</span
      ></label
    >
  </ConfirmSheet>
</template>

<style scoped>
.banner {
  margin: 0;
  padding: 14px var(--inset);
  font-size: 15px;
  line-height: 1.5;
}
.passkey {
  position: relative;
  display: flex;
  align-items: center;
  min-height: 56px;
  padding-left: var(--inset);
}
.passkey + .passkey::before,
.passkey + :deep(.row)::before {
  content: '';
  position: absolute;
  inset: 0 0 auto var(--inset);
  height: 1px;
  background: var(--separator);
}
.label {
  flex: 1;
  min-width: 0;
  padding: 10px 0;
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
  padding: 0 10px;
  font-size: 15px;
  color: var(--link);
}
.action:last-child {
  padding-right: var(--inset);
}
.action:active:not(:disabled) {
  background: var(--fill);
}
.remove {
  color: var(--destructive);
}
.option {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 0 16px 16px;
  font-size: 15px;
}
.option input {
  width: 20px;
  height: 20px;
  accent-color: var(--destructive);
}
</style>
