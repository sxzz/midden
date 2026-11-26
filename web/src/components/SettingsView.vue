<script setup vapor lang="ts">
import { shallowRef } from 'vue'
import { call, client, errorText } from '../api'
import { toast } from '../composables/useToast'
import { host } from '../host'
import { buildFacts, REPOSITORY } from '../settings'
import ApiTokens from './ApiTokens.vue'
import AppLink from './ui/AppLink.vue'
import ListButton from './ui/ListButton.vue'
import ListSection from './ui/ListSection.vue'

// 设置: a list of its pages, iOS style, then the facts about this build.
const about = buildFacts(__BUILD_VERSION__, __BUILD_TIME__)
// Inside Telegram the Mini App signs in again on every open; only a browser
// session is worth ending by hand.
const browser = !host()?.initData
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
</script>

<template>
  <ListSection>
    <ListButton
      label="采集账号"
      variant="plain"
      chevron
      :to="{ name: 'settings-accounts' }"
    />
    <ListButton
      label="通行密钥"
      variant="plain"
      chevron
      :to="{ name: 'settings-passkeys' }"
    />
    <ListButton
      label="定期更新"
      variant="plain"
      chevron
      :to="{ name: 'settings-watches' }"
    />
  </ListSection>
  <ApiTokens />
  <ListSection>
    <ListButton
      label="管理员面板"
      variant="plain"
      chevron
      :to="{ name: 'settings-admin' }"
    />
  </ListSection>
  <ListSection title="关于">
    <div class="fact">
      <span class="name">版本</span>
      <AppLink v-if="about.commitURL" class="value" :href="about.commitURL"
        ><code>{{ about.version }}</code></AppLink
      >
      <code v-else class="value">{{ about.version }}</code>
    </div>
    <div v-if="about.builtAt" class="fact">
      <span class="name">构建时间</span>
      <span class="value">{{ about.builtAt }}</span>
    </div>
    <AppLink class="fact" :href="REPOSITORY">
      <span class="name">源代码</span>
      <span class="value link">github.com/sxzz/midden ↗</span>
    </AppLink>
  </ListSection>
  <ListSection v-if="browser">
    <ListButton
      label="退出登录"
      variant="destructive"
      :disabled="busy"
      @select="logout"
    />
  </ListSection>
</template>

<style scoped>
.fact {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 48px;
  padding: 11px var(--inset);
  font-size: 16px;
  color: var(--text);
}
.fact + .fact::before {
  content: '';
  position: absolute;
  inset: 0 0 auto var(--inset);
  height: 1px;
  background: var(--separator);
}
.name {
  flex: 1;
  min-width: 0;
}
.value {
  flex-shrink: 0;
  color: var(--subtle);
  font-size: 15px;
}
a.value,
.link {
  color: var(--link);
}
a.fact:active {
  background: var(--fill);
}
code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 14px;
}
</style>
