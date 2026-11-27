<script setup vapor lang="ts">
import { computed, onMounted, onUnmounted, shallowRef, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useTabLinks } from '../composables/useTabLinks'
import {
  barHidden,
  barSettling,
  nextScroll,
  scrollStart,
  settleBar,
  shownTabs,
  tabBarSuppressed,
} from '../tabbar'
import AppLink from './ui/AppLink.vue'
import TabIcon from './ui/TabIcon.vue'
// The bottom bar of the owner's app on a phone: 探索, 关系, 设置. It slides
// away while the page scrolls down and back as soon as it scrolls up, as
// X's does. Wider windows have the rail (SideRail) instead.
const route = useRoute()
const { active, links, tap } = useTabLinks()
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
const hidden = computed(() =>
  barHidden({
    scrolled: scroll.value.hidden,
    typing: typing.value,
    suppressed: tabBarSuppressed.value.size > 0,
  }),
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
        v-for="tab in shownTabs()"
        :key="tab.value"
        class="item"
        :class="{ on: active === tab.value }"
        :to="links[tab.value]"
        :data-tab="tab.value"
        :aria-current="active === tab.value ? 'page' : undefined"
      >
        <TabIcon :name="tab.value" :active="active === tab.value" />
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
