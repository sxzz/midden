<script setup vapor lang="ts">
import { computed, onMounted, shallowRef } from 'vue'
import {
  call,
  client,
  errorText,
  type Account,
  type AccountPlatform,
  type Accounts,
} from '../api'
import { toast } from '../composables/useToast'
import AddAccountSheet from './AddAccountSheet.vue'
import ConfirmSheet from './ConfirmSheet.vue'
import ListButton from './ui/ListButton.vue'
import ListSection from './ui/ListSection.vue'

// 采集 → 采集账号: the accounts each platform captures with, in a dialog
// (AccountsDialog).
const AT_PREFIX = /^@/
const data = shallowRef<Accounts>()
const loading = shallowRef(true)
const error = shallowRef('')
const busy = shallowRef(false)
/** The platform whose add-account sheet is open. */
const adding = shallowRef<AccountPlatform>()
const addError = shallowRef('')
const removing = shallowRef<Account>()
const addable = computed(() => data.value?.platforms.some((p) => p.can_add))

async function load() {
  loading.value = true
  try {
    const accounts = await call(client.accounts.$get())
    accounts.platforms.sort(
      (a, b) => Number(b.id === 'x') - Number(a.id === 'x'),
    )
    data.value = accounts
    error.value = ''
  } catch (e) {
    error.value = errorText(e)
  } finally {
    loading.value = false
  }
}
// The bot can change the selection too; read it whenever the dialog opens.
onMounted(load)

function label(a: Account) {
  if (!a.username) return a.name
  const handle = `@${a.username.replace(AT_PREFIX, '')}`
  return a.name ? `${handle} · ${a.name}` : handle
}
function accountsOf(platform: string) {
  return data.value?.accounts.filter((a) => a.platform === platform) || []
}
function openAdd(platform: AccountPlatform) {
  addError.value = ''
  adding.value = platform
}

async function select(platform: string, account = '') {
  if (busy.value) return
  busy.value = true
  try {
    data.value = await call(
      client.accounts.selection.$put({
        json: { platform, account_id: account },
      }),
    )
  } catch (e) {
    toast(errorText(e))
  } finally {
    busy.value = false
  }
}
async function add(credential: string, name: string) {
  const platform = adding.value?.id
  if (!platform || busy.value) return
  busy.value = true
  addError.value = ''
  try {
    const account = await call(
      client.accounts.$post({ json: { platform, credential, name } }),
    )
    adding.value = undefined
    toast(`已添加并选择 ${label(account)}。`)
    await load()
  } catch (e) {
    addError.value = errorText(e)
  } finally {
    busy.value = false
  }
}
async function remove() {
  const account = removing.value
  if (!account || busy.value) return
  busy.value = true
  try {
    await call(client.accounts[':id'].$delete({ param: { id: account.id } }))
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
  <p v-if="loading && !data" class="status" role="status">加载中…</p>
  <ListSection v-else-if="error && !data">
    <p class="banner" role="alert">{{ error }}</p>
    <ListButton label="重试" @select="load" />
  </ListSection>
  <template v-else-if="data">
    <template v-for="p in data.platforms" :key="p.id">
      <ListSection
        v-if="p.public || p.can_add || accountsOf(p.id).length"
        :title="`${p.name} 采集来源`"
      >
        <p v-if="!p.public && !p.selected_account_id" class="banner">
          {{ p.name }} 需要先添加并选择一个账号才能采集。
        </p>
        <ListButton
          v-if="p.public"
          label="公共来源"
          variant="plain"
          :trailing="p.selected_account_id ? '' : '✓'"
          :disabled="busy"
          @select="select(p.id)"
        />
        <div v-for="a in accountsOf(p.id)" :key="a.id" class="account">
          <button
            type="button"
            class="pick"
            :disabled="busy || a.state !== 'ready'"
            :aria-pressed="a.selected"
            @click="select(p.id, a.id)"
          >
            <span class="label"
              >{{ label(a)
              }}<small v-if="a.state !== 'ready'" class="hint"
                >需重新授权</small
              ></span
            ><span v-if="a.selected" class="check" aria-hidden="true">✓</span>
          </button>
          <button
            type="button"
            class="remove"
            :aria-label="`删除 ${label(a)}`"
            :disabled="busy"
            @click="removing = a"
          >
            删除
          </button>
        </div>
        <ListButton
          v-if="p.can_add"
          label="添加账号"
          :disabled="busy"
          @select="openAdd(p)"
        />
      </ListSection>
    </template>
    <p v-if="!addable" class="status">没有支持添加账号的平台。</p>
  </template>
  <ConfirmSheet
    :open="!!removing"
    :title="`删除 ${removing ? label(removing) : ''}？`"
    :description="
      data?.platforms.find((p) => p.id === removing?.platform)?.public
        ? '正在使用此账号时，新保存改用公共来源。'
        : '删除后，需要选择其他账号或重新添加才能采集。'
    "
    confirm-label="删除账号"
    :busy="busy"
    @confirm="remove"
    @cancel="removing = undefined"
  />
  <AddAccountSheet
    :open="!!adding"
    :name="adding?.name ?? ''"
    :help="adding?.help"
    :busy="busy"
    :error="addError"
    @submit="add"
    @cancel="adding = undefined"
  />
</template>

<style scoped>
.status {
  margin: 0;
  padding: 48px 32px;
  text-align: center;
  font-size: 15px;
  line-height: 1.6;
  color: var(--subtle);
}
.banner {
  margin: 0;
  padding: 14px var(--inset);
  font-size: 15px;
  line-height: 1.5;
}
.account {
  position: relative;
  display: flex;
  align-items: center;
}
.account::before,
.account + .account::before {
  content: '';
  position: absolute;
  inset: 0 0 auto var(--inset);
  height: 1px;
  background: var(--separator);
}
/* The add button follows accounts or the notice, not another list row. */
.account + :deep(.row)::before,
.banner + :deep(.row)::before {
  content: '';
  position: absolute;
  inset: 0 0 auto var(--inset);
  height: 1px;
  background: var(--separator);
}
.account:first-child::before {
  display: none;
}
.pick {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 12px;
  min-width: 0;
  min-height: 48px;
  padding: 11px 0 11px var(--inset);
  font-size: 16px;
  color: var(--text);
}
.pick:disabled {
  opacity: 1;
}
.pick:active:not(:disabled),
.remove:active:not(:disabled) {
  background: var(--fill);
}
.label {
  flex: 1;
  min-width: 0;
}
.hint {
  display: block;
  font-size: 13px;
  color: var(--destructive);
}
.check {
  flex-shrink: 0;
  font-size: 15px;
  color: var(--link);
}
.remove {
  flex-shrink: 0;
  min-height: 48px;
  padding: 0 var(--inset);
  font-size: 15px;
  color: var(--destructive);
}
</style>
