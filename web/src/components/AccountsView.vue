<script setup vapor lang="ts">
import { computed, onActivated, shallowRef } from 'vue'
import { api, errorText, type Account, type Accounts } from '../api'
import { host } from '../host'
import ConfirmSheet from './ConfirmSheet.vue'
import ListButton from './ui/ListButton.vue'
import ListSection from './ui/ListSection.vue'
const data = shallowRef<Accounts>()
const loading = shallowRef(true)
const error = shallowRef('')
const busy = shallowRef(false)
interface Draft {
  credential: string
  name: string
}
const drafts = shallowRef<Record<string, Draft>>({})
const notice = shallowRef<{
  platform: string
  text: string
  failed?: boolean
}>()
const removing = shallowRef<Account>()
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
function draft(platform: string): Draft {
  return drafts.value[platform] || { credential: '', name: '' }
}
function edit(platform: string, key: keyof Draft, event: Event) {
  const value = (event.target as HTMLInputElement | HTMLTextAreaElement).value
  drafts.value = {
    ...drafts.value,
    [platform]: { ...draft(platform), [key]: value },
  }
}

async function select(platform: string, account = '') {
  if (busy.value) return
  busy.value = true
  notice.value = undefined
  try {
    data.value = await api<Accounts>('/accounts/selection', {
      method: 'PUT',
      body: JSON.stringify({ platform, account_id: account }),
    })
  } catch (e) {
    notice.value = { platform, text: errorText(e), failed: true }
  } finally {
    busy.value = false
  }
}
async function add(platform: string) {
  const value = draft(platform).credential.trim()
  if (!value || busy.value) return
  busy.value = true
  notice.value = undefined
  try {
    const account = await api<Account>('/accounts', {
      method: 'POST',
      body: JSON.stringify({
        platform,
        credential: value,
        name: draft(platform).name.trim(),
      }),
    })
    drafts.value = { ...drafts.value, [platform]: { credential: '', name: '' } }
    notice.value = { platform, text: `已添加并选择 ${label(account)}。` }
    await load()
  } catch (e) {
    notice.value = { platform, text: errorText(e), failed: true }
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
    notice.value = {
      platform: account.platform,
      text: errorText(e),
      failed: true,
    }
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
        footnote="只影响新保存的内容；重新抓取沿用原来的来源。"
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
      </ListSection>
      <ListSection
        v-if="p.can_add"
        :title="`添加 ${p.name} 账号`"
        :footnote="p.help"
      >
        <form class="form" @submit.prevent="add(p.id)">
          <label class="field">
            <span class="field-label">凭据</span>
            <textarea
              :value="draft(p.id).credential"
              rows="3"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              placeholder="粘贴凭据"
              @input="edit(p.id, 'credential', $event)"
            />
          </label>
          <label class="field">
            <span class="field-label">名称（可选）</span>
            <input
              :value="draft(p.id).name"
              maxlength="100"
              autocomplete="off"
              placeholder="用于区分多个账号"
              @input="edit(p.id, 'name', $event)"
            />
          </label>
          <p
            v-if="notice?.platform === p.id"
            class="notice"
            :class="{ failed: notice.failed }"
            :role="notice.failed ? 'alert' : 'status'"
          >
            {{ notice.text }}
          </p>
          <button
            type="submit"
            class="submit"
            :disabled="busy || !draft(p.id).credential.trim()"
          >
            {{ busy ? '正在验证…' : '验证并添加' }}
          </button>
        </form>
      </ListSection>
      <p
        v-else-if="notice?.platform === p.id"
        class="notice outside"
        role="alert"
      >
        {{ notice.text }}
      </p>
    </template>
    <p v-if="!addable" class="status">未配置个人账号接入。</p>
  </template>
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
.form {
  margin: 0;
}
.field {
  position: relative;
  display: block;
  padding: 13px var(--inset) 12px;
}
.field + .field::before {
  content: '';
  position: absolute;
  inset: 0 0 auto var(--inset);
  height: 1px;
  background: var(--separator);
}
.field-label {
  display: block;
  margin-bottom: 9px;
  color: var(--subtle);
  font-size: 13px;
  font-weight: 600;
}
textarea,
input {
  display: block;
  width: 100%;
  padding: 11px 13px;
  border: 0;
  border-radius: 12px;
  background: var(--fill);
  line-height: 1.55;
}
textarea {
  min-height: 82px;
  resize: vertical;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 14px;
  word-break: break-all;
}
textarea::placeholder,
input::placeholder {
  color: var(--subtle);
}
.notice {
  margin: 0;
  padding: 0 var(--inset) 12px;
  font-size: 14px;
  line-height: 1.5;
  color: var(--subtle);
}
.notice.failed {
  color: var(--destructive);
}
.notice.outside {
  margin: -10px 0 22px;
  padding: 0 calc(var(--gutter) + 4px);
}
.submit {
  position: relative;
  display: block;
  width: 100%;
  min-height: 48px;
  padding: 11px var(--inset);
  font-size: 16px;
  text-align: center;
  color: var(--link);
  box-shadow: inset 0 1px 0 var(--separator);
}
.submit:disabled {
  color: var(--subtle);
}
.submit:active:not(:disabled) {
  background: var(--fill);
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
