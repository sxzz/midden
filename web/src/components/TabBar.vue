<script setup vapor lang="ts">
import { computed, onMounted, onUnmounted, shallowRef, watch } from 'vue'
import { useRoute, useRouter, type RouteLocationRaw } from 'vue-router'
import { navigatesHere } from '../navigation'
import { lastPage, SWITCH_STATE, tabStates } from '../tab-state'
import {
  barSettling,
  isTabRoot,
  nextScroll,
  scrollStart,
  settleBar,
  tabBarSuppressed,
  tabOf,
  tabs,
  type Tab,
} from '../tabbar'
import AppLink from './ui/AppLink.vue'
// The bottom bar of the owner's app: 探索, 关系, 设置. It slides away while
// the page scrolls down and back as soon as it scrolls up, as X's does.
const route = useRoute()
const router = useRouter()
const active = computed(() => tabOf(route.name))
/**
 * Where each tab leads, which its link's address says too: another tab to
 * the page it was left on, the open one to its root (as last shown). The
 * bar's own entry is marked so 返回 there knows the reader did not come
 * from the page before it in history.
 */
function linkTo(tab: Tab): RouteLocationRaw {
  const states = tabStates.value
  if (tab === active.value) return states[tab].root
  // History state rides only on a location object, whose `path` cannot
  // carry the query.
  const { path, query, hash } = router.resolve(lastPage(states, tab))
  return { path, query, hash, state: SWITCH_STATE }
}
const links = computed(
  () =>
    Object.fromEntries(
      tabs.map(({ value }) => [value, linkTo(value)]),
    ) as Record<Tab, RouteLocationRaw>,
)
const scroll = shallowRef(scrollStart())
/**
 * On a touch screen the keyboard is up while a text field has focus; the
 * bar would ride on top of it and cover what is being typed.
 */
const typing = shallowRef(false)
const touch = () => !!globalThis.matchMedia?.('(pointer: coarse)').matches
const TEXT = 'textarea, [contenteditable], input'
const NOT_TEXT =
  /^(?:button|checkbox|color|file|image|radio|range|reset|submit)$/
function isTextField(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    target.matches(TEXT) &&
    (!(target instanceof HTMLInputElement) || !NOT_TEXT.test(target.type))
  )
}
function focusIn(event: FocusEvent) {
  typing.value = touch() && isTextField(event.target)
}
function focusOut(event: FocusEvent) {
  typing.value = touch() && isTextField(event.relatedTarget)
}
const hidden = computed(
  () => scroll.value.hidden || typing.value || tabBarSuppressed.value.size > 0,
)
// A page shown again restores its scroll position; that jump is not the
// reader scrolling, so the bar stays up for a moment after each change.
function onScroll() {
  const y = window.scrollY
  if (barSettling()) {
    scroll.value = scrollStart(y)
    return
  }
  const max = document.documentElement.scrollHeight - window.innerHeight
  scroll.value = nextScroll(scroll.value, y, max)
}
watch(
  () => route.fullPath,
  () => {
    settleBar(400)
    scroll.value = scrollStart(window.scrollY)
  },
)
// The page pads itself for the bar and the toast rises above it, keyed on
// the body so both read it wherever they sit.
watch(
  hidden,
  (value) => {
    document.body.dataset.tabBar = value ? 'hidden' : 'shown'
  },
  { immediate: true },
)
onMounted(() => {
  window.addEventListener('scroll', onScroll, { passive: true })
  document.addEventListener('focusin', focusIn)
  document.addEventListener('focusout', focusOut)
})
onUnmounted(() => {
  window.removeEventListener('scroll', onScroll)
  document.removeEventListener('focusin', focusIn)
  document.removeEventListener('focusout', focusOut)
  delete document.body.dataset.tabBar
})
/**
 * Tapping the tab already open: on its root, back to the top; deeper, its
 * link leads to the root.
 */
function tap(event: MouseEvent) {
  const link =
    event.target instanceof Element
      ? event.target.closest<HTMLElement>('[data-tab]')
      : null
  if (
    !link ||
    link.dataset.tab !== active.value ||
    !isTabRoot(route.name) ||
    !navigatesHere(event)
  )
    return
  event.preventDefault()
  window.scrollTo({ top: 0, behavior: 'smooth' })
}
</script>

<template>
  <nav
    class="tab-bar"
    :class="{ hidden }"
    aria-label="主导航"
    data-tab-bar-nav
    @click.capture="tap"
  >
    <div class="items">
      <AppLink
        v-for="tab in tabs"
        :key="tab.value"
        class="item"
        :class="{ on: active === tab.value }"
        :to="links[tab.value]"
        :data-tab="tab.value"
        :aria-current="active === tab.value ? 'page' : undefined"
      >
        <svg
          viewBox="0 0 24 24"
          width="24"
          height="24"
          fill="none"
          stroke="currentColor"
          :stroke-width="active === tab.value ? 2.3 : 1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <template v-if="tab.value === 'explore'">
            <circle cx="10.5" cy="10.5" r="6.5" />
            <path d="m15.5 15.5 5 5" />
          </template>
          <template v-else-if="tab.value === 'relations'">
            <circle cx="12" cy="5.5" r="2.5" />
            <circle cx="5" cy="18" r="2.5" />
            <circle cx="19" cy="18" r="2.5" />
            <path d="M10.8 7.7 6.2 15.8M13.2 7.7l4.6 8.1M7.5 18h9" />
          </template>
          <template v-else>
            <circle cx="12" cy="12" r="3" />
            <path
              d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"
            />
          </template>
        </svg>
        <span class="label">{{ tab.label }}</span>
      </AppLink>
    </div>
  </nav>
</template>

<style>
/* Telegram reports its own insets where the device's are not exposed. */
:root {
  --tab-bar-height: 52px;
  --tab-bar-inset: max(
    env(safe-area-inset-bottom, 0px),
    calc(
      var(--tg-safe-area-inset-bottom, 0px) +
        var(--tg-content-safe-area-inset-bottom, 0px)
    )
  );
}
/* Room the page keeps below its content while the bar is on it, hidden for
   now or not, so a list never ends behind it. */
body[data-tab-bar] {
  --tab-bar-space: calc(var(--tab-bar-height) + var(--tab-bar-inset));
}
/* What floats above the bottom edge (the toast) rises above it when up. */
body[data-tab-bar='shown'] {
  --tab-bar-offset: var(--tab-bar-space);
}
</style>

<style scoped>
.tab-bar {
  position: fixed;
  inset: auto 0 0;
  z-index: 20;
  padding-bottom: var(--tab-bar-inset);
  background: color-mix(in srgb, var(--card) 88%, transparent);
  -webkit-backdrop-filter: saturate(180%) blur(20px);
  backdrop-filter: saturate(180%) blur(20px);
  box-shadow: 0 -1px 0 var(--separator);
  transition:
    transform 220ms ease,
    opacity 220ms ease;
}
.tab-bar.hidden {
  transform: translateY(100%);
  opacity: 0;
  pointer-events: none;
}
.items {
  display: flex;
  max-width: 560px;
  height: var(--tab-bar-height);
  margin: 0 auto;
}
.item {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  min-width: 0;
  color: var(--subtle);
  font-size: 11px;
  line-height: 1.2;
  -webkit-tap-highlight-color: transparent;
}
.item.on {
  color: var(--text);
  font-weight: 600;
}
.item:active svg {
  transform: scale(0.9);
}
.item svg {
  transition: transform 120ms ease;
}
.item:focus-visible {
  outline: 2px solid var(--link);
  outline-offset: -4px;
  border-radius: 12px;
}
@media (prefers-reduced-motion: reduce) {
  .tab-bar,
  .item svg {
    transition: none;
  }
}
</style>
