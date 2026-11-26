<script setup vapor lang="ts">
import { computed, onMounted, onUnmounted, shallowRef } from 'vue'
import { call, client, errorText } from '../api'
import { toast } from '../composables/useToast'
import { host } from '../host'
import AppLink from './ui/AppLink.vue'
import type { PlatformUser } from '../user'
// The foot of the rail: who is signed in to Midden (see user.ts), with a
// menu of what concerns the whole instance.
const props = defineProps<{ user: PlatformUser }>()
const initial = computed(() => props.user.name.slice(0, 1).toUpperCase())
// Inside Telegram the Mini App signs in again on every open; only a browser
// session is worth ending by hand.
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
  document.addEventListener('pointerdown', outside)
  document.addEventListener('keydown', escape)
})
onUnmounted(() => {
  document.removeEventListener('pointerdown', outside)
  document.removeEventListener('keydown', escape)
})
</script>

<template>
  <div class="who">
    <button
      type="button"
      class="account"
      :aria-expanded="menu"
      aria-haspopup="menu"
      aria-label="账号菜单"
      :title="user.name"
      @click="menu = !menu"
    >
      <span class="avatar" aria-hidden="true">{{ initial }}</span>
      <span class="lines">
        <span class="account-name">{{ user.name }}</span>
        <span class="account-meta">{{ user.detail }}</span>
      </span>
    </button>
    <div v-if="menu" class="menu" role="menu">
      <p class="menu-host">{{ user.name }} · {{ user.detail }}</p>
      <AppLink
        class="menu-item"
        role="menuitem"
        :to="{ name: 'settings', params: { section: 'admin' } }"
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
</template>

<style scoped>
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
.account:hover {
  background: var(--fill);
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
/* The name shows with the rail's labels, from 1280px (layout.ts). */
.lines {
  display: none;
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
  overflow: hidden;
  font-size: 13px;
  color: var(--subtle);
  text-overflow: ellipsis;
  white-space: nowrap;
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
  .lines {
    display: flex;
  }
  .account {
    width: 100%;
    text-align: left;
  }
}
@media (prefers-reduced-motion: reduce) {
  .account {
    transition: none;
  }
}
</style>
