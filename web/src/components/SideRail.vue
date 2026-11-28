<script setup vapor lang="ts">
import { computed } from 'vue'
import { PROFILE_PATH, useInstall } from '../composables/useInstall'
import { useTabLinks } from '../composables/useTabLinks'
import { shownTabs } from '../tabbar'
import { darkTheme, toggleTheme } from '../theme'
import { currentUser } from '../user'
import RailUser from './RailUser.vue'
import AppLink from './ui/AppLink.vue'
import TabIcon from './ui/TabIcon.vue'
// The desktop rail, in the bottom bar's place from 700px (layout.ts): the
// tabs, and who is signed in. Icons only until 1280px,
// labels beside them from there.
const { active, links, tap } = useTabLinks()
/** Light or dark, named by what it switches to; none inside Telegram. */
const theme = computed(() => {
  const dark = darkTheme.value
  if (!dark) return undefined
  return dark.value
    ? { dark: true, label: '切换到浅色模式' }
    : { dark: false, label: '切换到深色模式' }
})
// 添加到桌面 beside it: Chrome's install prompt, or iOS Safari's profile.
const { way: installWay, install } = useInstall()
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
          viewBox="4 6 24 20"
          width="28"
          height="28"
          fill="currentColor"
          aria-hidden="true"
        >
          <!-- The favicon's heap (public/favicon.svg), without its tile. -->
          <rect x="11" y="7" width="10" height="4" rx="2" />
          <rect x="8" y="14" width="16" height="4" rx="2" />
          <rect x="5" y="21" width="22" height="4" rx="2" />
        </svg>
        <span class="label name">Midden</span>
      </AppLink>
      <nav class="items" aria-label="主导航" @click.capture="tap">
        <AppLink
          v-for="tab in shownTabs()"
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
      <div class="foot">
        <div v-if="theme || installWay" class="tools">
          <button
            v-if="theme"
            type="button"
            class="tool"
            :aria-label="theme.label"
            :title="theme.label"
            @click="toggleTheme"
          >
            <svg
              viewBox="0 0 24 24"
              width="20"
              height="20"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <template v-if="theme.dark">
                <circle cx="12" cy="12" r="4" />
                <path
                  d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"
                />
              </template>
              <path v-else d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
            </svg>
          </button>
          <button
            v-if="installWay === 'prompt'"
            type="button"
            class="tool"
            aria-label="添加到桌面"
            title="添加到桌面"
            @click="install"
          >
            <svg
              viewBox="0 0 24 24"
              width="20"
              height="20"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <rect x="4" y="4" width="16" height="16" rx="4" />
              <path d="M12 8.5v7M8.5 12h7" />
            </svg>
          </button>
          <a
            v-else-if="installWay === 'profile'"
            class="tool"
            :href="PROFILE_PATH"
            aria-label="添加到桌面"
            title="添加到桌面"
          >
            <svg
              viewBox="0 0 24 24"
              width="20"
              height="20"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <rect x="4" y="4" width="16" height="16" rx="4" />
              <path d="M12 8.5v7M8.5 12h7" />
            </svg>
          </a>
        </div>
        <RailUser :user="currentUser()" />
      </div>
    </div>
  </header>
</template>

<style scoped>
/* The rail's widths are layout.ts's (--rail-width): 88px of icons, 200px
   with labels. */
/* The rail itself sticks: it is the row's item, which the whole page's
   height can carry; a sticky element inside it could only move within the
   rail's own height. Above the column's sticky header, for the account
   menu to open over it. */
.rail {
  position: sticky;
  top: 0;
  z-index: 20;
  flex: none;
  align-self: flex-start;
  width: var(--rail-width);
}
.sticky {
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
/* Who is signed in, at the rail's foot, with the theme and 添加到桌面 as
   small icon buttons side by side on their own line above the avatar, at
   every rail width, so the account row keeps its whole width for the name.
   Secondary controls, so not set as the tabs. In the 88px rail the pair is
   wider than its padding leaves and, centred, reaches into it. */
.foot {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  margin-top: auto;
}
.tools {
  display: flex;
  flex: none;
  gap: 4px;
}
.tool {
  display: grid;
  flex: none;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  color: var(--subtle);
  transition: background 120ms ease;
}
.tool:hover {
  background: var(--fill);
  color: var(--text);
}
.tool:focus-visible {
  outline-offset: -2px;
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
.item:hover {
  background: var(--fill);
}
.item:focus-visible,
.logo:focus-visible {
  outline-offset: -2px;
  border-radius: 999px;
}
@media (min-width: 1280px) {
  .sticky {
    align-items: stretch;
  }
  .label {
    display: inline;
  }
  .items {
    align-items: flex-start;
  }
  .foot {
    align-items: stretch;
    align-self: stretch;
  }
  .foot > :deep(.who) {
    min-width: 0;
  }
  /* The first button centred on the avatar's column: RailUser's 10px
     padding plus half its 40px avatar, less half of a 36px button. */
  .tools {
    align-self: flex-start;
    margin-left: 12px;
  }
  .logo,
  .item {
    align-self: flex-start;
    padding-right: 24px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .logo,
  .item,
  .tool {
    transition: none;
  }
}
</style>
