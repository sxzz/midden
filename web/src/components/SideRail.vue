<script setup vapor lang="ts">
import { computed, onMounted, onUnmounted, shallowRef } from 'vue'
import { call, client, errorText } from '../api'
import { useTabLinks } from '../composables/useTabLinks'
import { toast } from '../composables/useToast'
import { host } from '../host'
import { tabs } from '../tabbar'
import AppLink from './ui/AppLink.vue'
import TabIcon from './ui/TabIcon.vue'
// The desktop rail, in the bottom bar's place from 700px (layout.ts): the
// app's name, the tabs, and who is signed in. Icons only until 1280px,
// labels beside them from there.
const { active, links, tap } = useTabLinks()

/** The collecting account in use, as who this library belongs to. */
const account = shallowRef<{ name: string; username?: string }>()
const instance = location.host
async function loadAccount() {
  try {
    const { platforms, accounts } = await call(client.accounts.$get())
    if (!Array.isArray(accounts)) return
    const selected = new Set(
      (platforms ?? []).map((p) => p.selected_account_id).filter(Boolean),
    )
    account.value =
      accounts.find((a) => a.platform === 'x' && selected.has(a.id)) ??
      accounts.find((a) => selected.has(a.id)) ??
      accounts[0]
  } catch {
    // Without an answer the rail names the instance alone.
  }
}
const browser = !host()?.initData
const menu = shallowRef(false)
const busy = shallowRef(false)
async function logout() {
  busy.value = true
  try {
    await call(client.session.$delete())
    location.reload()
  } catch (e) {
    toast(errorText(e))
    busy.value = false
  }
}
function outside(event: Event) {
  if (
    menu.value &&
    event.target instanceof Element &&
    !event.target.closest('.who')
  )
    menu.value = false
}
function escape(event: KeyboardEvent) {
  if (event.key === 'Escape') menu.value = false
}
onMounted(() => {
  void loadAccount()
  document.addEventListener('pointerdown', outside)
  document.addEventListener('keydown', escape)
})
onUnmounted(() => {
  document.removeEventListener('pointerdown', outside)
  document.removeEventListener('keydown', escape)
})
const initial = computed(() =>
  (account.value?.name || account.value?.username || 'M')
    .slice(0, 1)
    .toUpperCase(),
)
</script>

<template>
  <header class="rail">
    <div class="sticky">
      <AppLink
        class="logo"
        :to="links.explore"
        aria-label="Midden"
        title="Midden"
      >
        <svg
          viewBox="0 0 24 24"
          width="28"
          height="28"
          fill="currentColor"
          aria-hidden="true"
        >
          <rect x="8" y="5" width="8" height="3.4" rx="1.7" />
          <rect x="5" y="10.3" width="14" height="3.4" rx="1.7" />
          <rect x="2" y="15.6" width="20" height="3.4" rx="1.7" />
        </svg>
        <span class="label name">Midden</span>
      </AppLink>
      <nav class="items" aria-label="主导航" @click.capture="tap">
        <AppLink
          v-for="tab in tabs"
          :key="tab.value"
          class="item"
          :class="{ on: active === tab.value }"
          :to="links[tab.value]"
          :data-tab="tab.value"
          :aria-current="active === tab.value ? 'page' : undefined"
          :aria-label="tab.label"
          :title="tab.label"
        >
          <TabIcon
            :name="tab.value"
            :active="active === tab.value"
            :size="26"
          />
          <span class="label">{{ tab.label }}</span>
        </AppLink>
      </nav>
      <div class="who">
        <button
          type="button"
          class="account"
          :aria-expanded="menu"
          aria-haspopup="menu"
          aria-label="账号菜单"
          @click="menu = !menu"
        >
          <span class="avatar" aria-hidden="true">{{ initial }}</span>
          <span class="label lines">
            <span class="account-name">{{
              account?.name || account?.username || 'Midden'
            }}</span>
            <span class="account-meta">{{
              account?.username ? `@${account.username}` : instance
            }}</span>
          </span>
        </button>
        <div v-if="menu" class="menu" role="menu">
          <p class="menu-host">{{ instance }}</p>
          <AppLink
            class="menu-item"
            role="menuitem"
            :to="{ name: 'settings-accounts' }"
            @navigate="menu = false"
            >采集账号</AppLink
          >
          <AppLink
            class="menu-item"
            role="menuitem"
            :to="{ name: 'settings-admin' }"
            @navigate="menu = false"
            >管理员面板</AppLink
          >
          <button
            v-if="browser"
            type="button"
            class="menu-item destructive"
            role="menuitem"
            :disabled="busy"
            @click="logout"
          >
            退出登录
          </button>
        </div>
      </div>
    </div>
  </header>
</template>

<style scoped>
/* The rail's widths are layout.ts's: 88px of icons, 275px with labels. */
.rail {
  flex: none;
  width: 88px;
}
/* Above the column's sticky header, for the account menu to open over it. */
.sticky {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  align-items: center;
  height: 100dvh;
  min-height: 480px;
  padding: 4px 12px 12px;
}
.label {
  display: none;
}
.logo,
.item {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 12px;
  border-radius: 999px;
  color: var(--text);
  transition: background 120ms ease;
}
.logo {
  margin: 2px 0 4px;
}
.name {
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 0.01em;
}
.items {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.item {
  font-size: 19px;
  line-height: 24px;
}
.item.on {
  font-weight: 700;
}
.logo:hover,
.item:hover,
.account:hover {
  background: var(--fill);
}
.item:focus-visible,
.logo:focus-visible {
  outline-offset: -2px;
  border-radius: 999px;
}
.who {
  position: relative;
  margin-top: auto;
}
.account {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px;
  border-radius: 999px;
  transition: background 120ms ease;
}
.avatar {
  display: grid;
  flex: none;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--fill);
  font-size: 17px;
  font-weight: 600;
}
.lines {
  min-width: 0;
  flex-direction: column;
  line-height: 1.3;
}
.account-name {
  overflow: hidden;
  font-size: 15px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.account-meta {
  overflow: hidden;
  font-size: 14px;
  color: var(--subtle);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.menu {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  z-index: 30;
  width: 240px;
  padding: 6px 0;
  border-radius: 16px;
  background: var(--card);
  box-shadow:
    0 0 0 1px var(--separator),
    0 8px 28px rgba(0, 0, 0, 0.2);
}
.menu-host {
  margin: 0;
  padding: 8px 16px 10px;
  font-size: 13px;
  color: var(--subtle);
  box-shadow: inset 0 -1px 0 var(--separator);
}
.menu-item {
  display: block;
  width: 100%;
  padding: 12px 16px;
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
  text-align: left;
}
.menu-item:hover {
  background: var(--fill);
}
.destructive {
  color: var(--destructive);
}
@media (min-width: 1280px) {
  .rail {
    width: 275px;
  }
  .sticky {
    align-items: stretch;
  }
  .label {
    display: inline;
  }
  .items {
    align-items: flex-start;
  }
  .logo,
  .item {
    align-self: flex-start;
    padding-right: 24px;
  }
  .lines {
    display: flex;
  }
  .account {
    width: 100%;
    text-align: left;
  }
}
@media (prefers-reduced-motion: reduce) {
  .logo,
  .item,
  .account {
    transition: none;
  }
}
</style>
