<script setup vapor lang="ts">
import { computed, shallowRef } from 'vue'
import { useRoute } from 'vue-router'
import { call, client, errorText } from '../api'
import { toast } from '../composables/useToast'
import { host } from '../host'
import { RAIL, SIDEBAR, useMedia } from '../layout'
import { buildFacts, REPOSITORY } from '../settings'
import { searchSettings, shownSections, splitMatch } from '../settings-sections'
import { darkTheme } from '../theme'
import { can } from '../user'
import AdminView from './AdminView.vue'
import ApiTokens from './ApiTokens.vue'
import PasskeyList from './PasskeyList.vue'
import SessionList from './SessionList.vue'
import AppLink from './ui/AppLink.vue'
import ListSection from './ui/ListSection.vue'
import UsersView from './UsersView.vue'

// 设置, laid out as X's: the list of sections, then the chosen section (its
// line and its entries), then an entry, at most two levels. From 1000px
// (layout.ts) the list stays on the left and what is chosen shows on its
// right, the first section when none is; narrower, each is a page of its
// own, which 返回 leaves.
const emit = defineEmits<{
  /** Everything saved was deleted (管理员面板, development only). */
  cleared: []
}>()
const route = useRoute()
const split = useMedia(SIDEBAR)
/** From 700px the rail has the theme's button; on a phone it is here. */
const rail = useMedia(RAIL)
const themeShown = computed(() => !rail.value && !!darkTheme.value)
const dark = computed(() => !!darkTheme.value?.value)
function setDark(event: Event) {
  const theme = darkTheme.value
  if (theme) theme.value = (event.target as HTMLInputElement).checked
}
/** This user's sections: a viewer has none of the admin's (user.ts). */
const sections = shownSections(can.admin)
const section = computed(() => {
  const value = String(
    route.params.section || (split.value ? sections[0]!.value : ''),
  )
  return sections.find((s) => s.value === value)
})
const entry = computed(() =>
  section.value?.entries?.find(
    (e) => e.value === String(route.params.entry || ''),
  ),
)
/** What the narrow layout shows: one level at a time. */
const level = computed(() =>
  entry.value ? 'entry' : section.value ? 'section' : 'list',
)
const query = shallowRef('')
const found = computed(() => searchSettings(query.value, sections))
const sectionLink = (value: string) => ({
  name: 'settings-section',
  params: { section: value },
})
const entryLink = (sectionValue: string, value: string) => ({
  name: 'settings-entry',
  params: { section: sectionValue, entry: value },
})
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
  <div class="settings" :class="{ split }">
    <!-- The list of sections. -->
    <section v-if="split || level === 'list'" class="list" aria-label="设置">
      <header v-if="split" class="column-head">
        <h1>设置</h1>
      </header>
      <form class="search" role="search" @submit.prevent>
        <svg
          viewBox="0 0 24 24"
          width="18"
          height="18"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <circle cx="10.5" cy="10.5" r="6" />
          <path d="M15 15l4.5 4.5" />
        </svg>
        <input
          v-model="query"
          type="search"
          placeholder="搜索设置"
          aria-label="搜索设置"
          enterkeyhint="search"
        />
      </form>
      <nav class="rows" aria-label="设置的分区">
        <AppLink
          v-for="item in found.sections"
          :key="item.value"
          class="row"
          :class="{ on: split && section?.value === item.value }"
          :to="sectionLink(item.value)"
          :aria-current="
            split && section?.value === item.value ? 'page' : undefined
          "
        >
          <span class="row-text">
            <span class="row-label"
              ><template
                v-for="(part, i) in splitMatch(item.label, query)"
                :key="i"
                ><mark v-if="part.hit">{{ part.text }}</mark
                ><template v-else>{{ part.text }}</template></template
              ></span
            >
            <small v-if="query && item.hint" class="row-hint">{{
              item.hint
            }}</small>
          </span>
          <span class="chevron" aria-hidden="true">›</span>
        </AppLink>
        <AppLink
          v-for="{ section: owner, entry: item } in found.entries"
          :key="`${owner.value}/${item.value}`"
          class="row"
          :class="{
            on:
              split &&
              section?.value === owner.value &&
              entry?.value === item.value,
          }"
          :to="entryLink(owner.value, item.value)"
        >
          <span class="row-text">
            <span class="row-label"
              ><template
                v-for="(part, i) in splitMatch(item.label, query)"
                :key="i"
                ><mark v-if="part.hit">{{ part.text }}</mark
                ><template v-else>{{ part.text }}</template></template
              ></span
            >
            <small class="row-hint"
              >{{ owner.label
              }}<template v-if="item.hint"> · {{ item.hint }}</template></small
            >
          </span>
          <span class="chevron" aria-hidden="true">›</span>
        </AppLink>
        <p
          v-if="query && !found.sections.length && !found.entries.length"
          class="none"
        >
          没有找到「{{ query.trim() }}」
        </p>
        <label v-if="themeShown && !query" class="row theme-row">
          <span class="row-text"><span class="row-label">深色模式</span></span>
          <input
            type="checkbox"
            role="switch"
            class="switch"
            :checked="dark"
            @change="setDark"
          />
        </label>
        <button
          v-if="browser && !query"
          type="button"
          class="row logout"
          :disabled="busy"
          @click="logout"
        >
          <span class="row-text"><span class="row-label">退出登录</span></span>
        </button>
      </nav>
    </section>

    <!-- The chosen section, or one of its entries. -->
    <section
      v-if="section && (split || level !== 'list')"
      class="pane"
      :aria-label="entry?.label ?? section.label"
    >
      <header v-if="split" class="column-head">
        <AppLink
          v-if="entry"
          class="back"
          :to="sectionLink(section.value)"
          :aria-label="`返回${section.label}`"
          :title="section.label"
        >
          <svg
            viewBox="0 0 24 24"
            width="20"
            height="20"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M19 12H5M11 6l-6 6 6 6" />
          </svg>
        </AppLink>
        <h2>{{ entry?.label ?? section.label }}</h2>
      </header>
      <p v-if="entry ? entry.hint : section.hint" class="pane-hint">
        {{ entry ? entry.hint : section.hint }}
      </p>
      <template v-if="entry">
        <UsersView v-if="entry.value === 'users'" />
        <AdminView
          v-else-if="section.value === 'admin'"
          :entry="entry.value"
          @cleared="emit('cleared')"
        />
        <SessionList v-else-if="entry.value === 'sessions'" />
      </template>
      <template v-else>
        <nav
          v-if="section.entries"
          class="rows entries"
          :aria-label="section.label"
        >
          <AppLink
            v-for="item in section.entries"
            :key="item.value"
            class="row"
            :to="entryLink(section.value, item.value)"
          >
            <svg
              class="row-icon"
              viewBox="0 0 24 24"
              width="22"
              height="22"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <template v-if="item.icon === 'globe'">
                <circle cx="12" cy="12" r="9" />
                <path
                  d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z"
                />
              </template>
              <template v-else-if="item.icon === 'disk'">
                <ellipse cx="12" cy="6" rx="8" ry="3" />
                <path
                  d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"
                />
              </template>
              <template v-else-if="item.icon === 'devices'">
                <rect x="2.5" y="4.5" width="14" height="10" rx="1.5" />
                <path d="M1.5 18h11" />
                <rect x="15.5" y="9" width="7" height="11.5" rx="1.5" />
              </template>
              <template v-else-if="item.icon === 'users'">
                <circle cx="9" cy="8" r="3.5" />
                <path d="M2.5 20c.6-3.6 3.2-6 6.5-6s5.9 2.4 6.5 6" />
                <path
                  d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.4c1.6.9 2.7 2.9 3 5.6"
                />
              </template>
              <template v-else-if="item.icon === 'queue'">
                <path d="M8 6h12M8 12h12M8 18h12" />
                <circle cx="4" cy="6" r="1" />
                <circle cx="4" cy="12" r="1" />
                <circle cx="4" cy="18" r="1" />
              </template>
              <template v-else>
                <path
                  d="M7 18a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.6 1.5A3.8 3.8 0 0 1 17.5 18Z"
                />
                <path d="M12 11v5M9.5 13.5 12 11l2.5 2.5" />
              </template>
            </svg>
            <span class="row-text">
              <span class="row-label">{{ item.label }}</span>
              <small v-if="item.hint" class="row-hint">{{ item.hint }}</small>
            </span>
            <span class="chevron" aria-hidden="true">›</span>
          </AppLink>
        </nav>
        <PasskeyList v-if="section.value === 'passkeys'" bare />
        <ApiTokens v-else-if="section.value === 'tokens'" bare />
        <AdminView
          v-else-if="section.value === 'admin'"
          @cleared="emit('cleared')"
        />
        <ListSection v-else-if="section.value === 'about'">
          <div class="fact">
            <span class="name">版本</span>
            <AppLink
              v-if="about.commitURL"
              class="value"
              :href="about.commitURL"
              ><code>{{ about.version }}</code> ↗</AppLink
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
      </template>
    </section>
  </div>
</template>

<style scoped>
.column-head {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 53px;
  padding: 4px var(--inset);
  background: color-mix(in srgb, var(--page) 85%, transparent);
  -webkit-backdrop-filter: saturate(180%) blur(12px);
  backdrop-filter: saturate(180%) blur(12px);
}
.column-head h1,
.column-head h2 {
  margin: 0;
  overflow: hidden;
  font-size: 19px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.back {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  margin-left: -8px;
  border-radius: 50%;
  color: var(--text);
}
.back:hover {
  background: var(--fill);
}
.search {
  position: relative;
  display: flex;
  align-items: center;
  margin: 4px var(--gutter) 12px;
  color: var(--subtle);
}
.search svg {
  position: absolute;
  left: 14px;
  pointer-events: none;
}
.search input {
  width: 100%;
  height: 40px;
  padding: 0 14px 0 40px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: var(--fill);
  color: var(--text);
  font-size: 15px;
}
.search input:focus {
  outline: none;
  border-color: var(--link);
  background: var(--page);
}
.search input::placeholder {
  color: var(--subtle);
}
.rows {
  display: flex;
  flex-direction: column;
  margin: 0 0 22px;
}
.row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 14px;
  min-height: 52px;
  padding: 10px var(--inset) 10px calc(var(--gutter) + 4px);
  color: var(--text);
  font-size: 15px;
  text-align: left;
}
/* Rows run edge to edge of a column that clips them: ringed inside. */
.row:focus-visible {
  outline-offset: -2px;
}
.row:hover {
  background: var(--fill);
}
/* The chosen section: shaded, with a bar at its right edge, as X's. */
.row.on {
  background: var(--fill);
}
.row.on::after {
  content: '';
  position: absolute;
  inset: 0 0 0 auto;
  width: 2px;
  background: var(--link);
}
.row-icon {
  flex: none;
  color: var(--text);
}
.row-text {
  display: grid;
  flex: 1;
  min-width: 0;
  gap: 2px;
}
.row-label {
  overflow-wrap: anywhere;
}
.row-hint {
  font-size: 13px;
  line-height: 1.4;
  color: var(--subtle);
}
.chevron {
  flex: none;
  font-size: 20px;
  line-height: 1;
  color: var(--subtle);
}
mark {
  border-radius: 3px;
  background: color-mix(in srgb, var(--link) 30%, transparent);
  color: inherit;
}
/* 深色模式: a switch, as iOS's settings have it. */
.theme-row {
  margin-top: 8px;
  cursor: pointer;
  box-shadow: inset 0 1px 0 var(--separator);
}
.theme-row .row-text {
  flex: 1;
}
.switch {
  position: relative;
  flex: none;
  width: 46px;
  height: 28px;
  margin: 0;
  border-radius: 14px;
  background: var(--fill);
  appearance: none;
  cursor: pointer;
  transition: background 160ms ease;
}
.switch::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
  transition: transform 160ms ease;
}
.switch:checked {
  background: #34c759;
}
.switch:checked::after {
  transform: translateX(18px);
}
.switch:focus-visible {
  outline-offset: 2px;
}
@media (prefers-reduced-motion: reduce) {
  .switch,
  .switch::after {
    transition: none;
  }
}
.theme-row + .logout {
  margin-top: 0;
}
.logout {
  margin-top: 8px;
  color: var(--destructive);
  box-shadow: inset 0 1px 0 var(--separator);
}
.none {
  margin: 0;
  padding: 12px calc(var(--gutter) + 4px);
  font-size: 15px;
  color: var(--subtle);
}
.pane-hint {
  margin: 0 0 16px;
  padding: 0 calc(var(--gutter) + 4px);
  font-size: 14px;
  line-height: 1.5;
  color: var(--subtle);
}
.entries {
  margin-top: -4px;
}
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
/* From 1000px: the list on the left, what is chosen on its right, each
   column with its own heading, as X's settings. */
.settings.split {
  display: grid;
  grid-template-columns: minmax(280px, 360px) minmax(0, 1fr);
  min-height: 100dvh;
}
.split .list {
  position: sticky;
  top: 0;
  align-self: start;
  max-height: 100dvh;
  overflow: hidden auto;
  scrollbar-width: none;
}
/* The line between the columns runs the whole height, as the pane does. */
.split .pane {
  min-width: 0;
  box-shadow: -1px 0 0 var(--separator);
  padding-bottom: 32px;
}
.split .pane-hint {
  margin-top: 0;
}
</style>
