<script setup vapor lang="ts">
import { computed, onActivated, shallowRef } from 'vue'
import {
  api,
  errorText,
  type Account,
  type AccountPlatform,
  type Accounts,
  type LibrarySize,
} from '../api'
import { toast } from '../composables/useToast'
import { host } from '../host'
import AddAccountSheet from './AddAccountSheet.vue'
import ConfirmSheet from './ConfirmSheet.vue'
import ListButton from './ui/ListButton.vue'
import ListSection from './ui/ListSection.vue'
const data = shallowRef<Accounts>()
const loading = shallowRef(true)
const error = shallowRef('')
const busy = shallowRef(false)
/** The platform whose add-account sheet is open. */
const adding = shallowRef<AccountPlatform>()
const addError = shallowRef('')
const removing = shallowRef<Account>()
const emit = defineEmits<{
  /** Everything saved was deleted; lists must not show it any more. */
  cleared: []
}>()
/** What deleting everything would remove, read when the sheet opens. */
const library = shallowRef<LibrarySize>()
const clearing = shallowRef(false)
const clearDescription = computed(() => {
  const v = library.value
  if (!v) return ''
  return `${v.collections} 条收藏、${v.records} 条采集记录${v.running ? `（${v.running} 条进行中）` : ''}，无法恢复。`
})
async function askClear() {
  if (busy.value) return
  busy.value = true
  try {
    library.value = await api<LibrarySize>('/library')
    clearing.value = true
  } catch (e) {
    toast(errorText(e))
  } finally {
    busy.value = false
  }
}
async function clearAll() {
  if (busy.value) return
  busy.value = true
  try {
    const v = await api<LibrarySize>('/library/delete-all', {
      method: 'POST',
      body: JSON.stringify({ confirm: 'delete all' }),
    })
    clearing.value = false
    toast(`已删除 ${v.collections} 条收藏和 ${v.records} 条采集记录。`)
    emit('cleared')
  } catch (e) {
    toast(errorText(e))
  } finally {
    busy.value = false
  }
}
const addable = computed(() => data.value?.platforms.some((p) => p.can_add))
const version = /^([0-9a-f]{40})(-dirty)?$/.exec(__BUILD_VERSION__)
const versionText = version
  ? version[1].slice(0, 7) + (version[2] || '')
  : __BUILD_VERSION__
// Inside Telegram the Mini App signs in again on every open; only a browser
// session is worth ending by hand.
const browser = !host()?.initData
async function logout() {
  busy.value = true
  try {
    await api('/session', { method: 'DELETE' })
    location.reload()
  } catch (e) {
    error.value = errorText(e)
    busy.value = false
  }
}
const versionURL = version
  ? `https://github.com/sxzz/midden/commit/${version[1]}`
  : ''

async function load() {
  loading.value = true
  try {
    data.value = await api<Accounts>('/accounts')
    data.value.platforms.sort(
      (a, b) => Number(b.id === 'x') - Number(a.id === 'x'),
    )
    error.value = ''
  } catch (e) {
    error.value = errorText(e)
  } finally {
    loading.value = false
  }
}
// The bot can change the selection too; refresh whenever the page reappears.
onActivated(load)

function label(a: Account) {
  if (!a.username) return a.name
  const handle = `@${a.username.replace(/^@/, '')}`
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
    data.value = await api<Accounts>('/accounts/selection', {
      method: 'PUT',
      body: JSON.stringify({ platform, account_id: account }),
    })
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
    const account = await api<Account>('/accounts', {
      method: 'POST',
      body: JSON.stringify({ platform, credential, name }),
    })
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
    await api(`/accounts/${encodeURIComponent(account.id)}`, {
      method: 'DELETE',
    })
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
          {{ p.name }} 需要添加并选择自己的账号凭据后才能采集。
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
    <p v-if="!addable" class="status">未配置个人账号接入。</p>
  </template>
  <ListSection title="数据">
    <ListButton
      label="删除全部收藏和采集记录"
      variant="destructive"
      :disabled="busy"
      @select="askClear"
    />
  </ListSection>
  <ListSection v-if="browser">
    <ListButton
      label="退出登录"
      variant="destructive"
      :disabled="busy"
      @select="logout"
    />
  </ListSection>
  <p class="version">
    版本
    <a v-if="versionURL" :href="versionURL" target="_blank" rel="noopener"
      ><code>{{ versionText }}</code></a
    >
    <code v-else>{{ versionText }}</code>
  </p>
  <ConfirmSheet
    :open="!!removing"
    :title="`删除 ${removing ? label(removing) : ''}？`"
    :description="
      data?.platforms.find((p) => p.id === removing?.platform)?.public
        ? '正在使用此账号时，新保存改用公共来源。'
        : '删除后，需要选择其他账号或重新添加自己的凭据才能采集。'
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
  <ConfirmSheet
    :open="clearing"
    title="删除全部收藏和采集记录？"
    :description="clearDescription"
    confirm-label="永久删除"
    phrase="删除全部"
    :busy="busy"
    @confirm="clearAll"
    @cancel="clearing = false"
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
.version {
  margin: 0;
  padding: 8px calc(var(--gutter) + 4px) 24px;
  font-size: 13px;
  line-height: 1.5;
  text-align: center;
  color: var(--subtle);
}
.version a {
  color: var(--link);
}
.version code {
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
</style>
