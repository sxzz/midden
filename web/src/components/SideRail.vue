<script setup vapor lang="ts">
import { useTabLinks } from '../composables/useTabLinks'
import { tabs } from '../tabbar'
import { currentUser } from '../user'
import RailUser from './RailUser.vue'
import AppLink from './ui/AppLink.vue'
import TabIcon from './ui/TabIcon.vue'
// The desktop rail, in the bottom bar's place from 700px (layout.ts): the
// tabs, and who is signed in. Icons only until 1280px,
// labels beside them from there.
const { active, links, tap } = useTabLinks()
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
      <RailUser :user="currentUser()" />
    </div>
  </header>
</template>

<style scoped>
/* The rail's widths are layout.ts's: 88px of icons, 275px with labels. */
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
  width: 88px;
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
}
@media (prefers-reduced-motion: reduce) {
  .logo,
  .item {
    transition: none;
  }
}
</style>
