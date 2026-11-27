<script setup vapor lang="ts">
import { computed } from 'vue'
import { useTabLinks } from '../composables/useTabLinks'
import { tabs } from '../tabbar'
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
      <div class="foot">
        <button
          v-if="theme"
          type="button"
          class="theme"
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
/* Who is signed in, at the rail's foot, with the theme as a small icon
   button: above the avatar while the rail is icons only, at the end of
   the account row once it has labels. A secondary control, so not set as
   the tabs. */
.foot {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  margin-top: auto;
}
.theme {
  display: grid;
  flex: none;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  color: var(--subtle);
  transition: background 120ms ease;
}
.theme:hover {
  background: var(--fill);
  color: var(--text);
}
.theme:focus-visible {
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
    flex-direction: row-reverse;
    align-self: stretch;
  }
  .foot > :deep(.who) {
    flex: 1;
    min-width: 0;
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
  .theme {
    transition: none;
  }
}
</style>
