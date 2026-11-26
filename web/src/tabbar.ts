import { shallowRef } from 'vue'
import type { RouteLocationRaw, RouteRecordNameGeneric } from 'vue-router'

/** The app's three destinations, as the bottom bar and the rail list them. */
export type Tab = 'explore' | 'relations' | 'settings'

export const tabs: readonly {
  value: Tab
  label: string
  /** The root page's route name and plain address. */
  root: string
  path: string
}[] = [
  { value: 'explore', label: '探索', root: 'collections', path: '/' },
  { value: 'relations', label: '关系', root: 'relations', path: '/relations' },
  { value: 'settings', label: '设置', root: 'settings', path: '/settings' },
]

/**
 * Which tab a page belongs to, by its route alone: the same page always
 * lights the same tab, however it was reached. Relation pages (a profile's
 * graph, a comparison) are 关系's; settings pages 设置's; everything else
 * opens from the library. Public and setup pages have none.
 */
const owners: Record<string, Tab> = {
  collections: 'explore',
  folder: 'explore',
  collection: 'explore',
  'collection-stats': 'explore',
  'collection-changes': 'explore',
  'collection-follows': 'explore',
  captures: 'explore',
  capture: 'explore',
  relations: 'relations',
  'collection-graph': 'relations',
  compare: 'relations',
  settings: 'settings',
  'settings-accounts': 'settings',
  'settings-passkeys': 'settings',
  'settings-watches': 'settings',
  'settings-admin': 'settings',
  'settings-storage': 'settings',
  'settings-jobs': 'settings',
}

export function tabOf(name: RouteRecordNameGeneric): Tab | undefined {
  return typeof name === 'string' ? owners[name] : undefined
}

/** Whether the page is a tab's own root rather than one opened from it. */
export function isTabRoot(name: RouteRecordNameGeneric) {
  return tabs.some((tab) => tab.root === name)
}

/** A tab's root page. */
export function tabRoute(tab: Tab): RouteLocationRaw {
  return { name: tabs.find((t) => t.value === tab)!.root }
}

/**
 * The bar's auto-hide, as X does it: hidden once the page has moved
 * `threshold` pixels down, shown again once it has moved as far up. At the
 * top, and at the end where it cannot scroll further, it always shows.
 * `travel` is how far the page has gone in the direction that would flip it.
 */
export interface ScrollState {
  y: number
  hidden: boolean
  travel: number
}

export const SCROLL_THRESHOLD = 12

export function scrollStart(y = 0): ScrollState {
  return { y, hidden: false, travel: 0 }
}

export function nextScroll(
  state: ScrollState,
  y: number,
  /** The furthest the page can scroll. */
  max: number,
  threshold = SCROLL_THRESHOLD,
): ScrollState {
  // Overscroll (a rubber-band bounce) counts as being at the edge.
  if (y <= 0 || y >= max - 1) return scrollStart(y)
  const delta = y - state.y
  if (delta === 0) return state
  const toward = state.hidden ? -delta : delta
  const travel = toward > 0 ? state.travel + toward : 0
  if (travel >= threshold) return { y, hidden: !state.hidden, travel: 0 }
  return { y, hidden: state.hidden, travel }
}

/** Whether the bar is off the page. */
export function barHidden(state: {
  /** Scrolled away (see `nextScroll`). */
  scrolled: boolean
  /** The on-screen keyboard is up. */
  typing: boolean
  /** Something takes its place, as the 多选 bar does. */
  suppressed: boolean
}) {
  return state.suppressed || state.scrolled || state.typing
}

/**
 * Until when scrolling is the page restoring its position rather than the
 * reader, which does not move the bar.
 */
let settledAt = 0
export function settleBar(ms: number) {
  settledAt = Math.max(settledAt, performance.now() + ms)
}
export const barSettling = () => performance.now() < settledAt

/**
 * Pages that hide the bar while they show something in its place, such as
 * the 多选 bar: each holds its own key until done.
 */
export const tabBarSuppressed = shallowRef<ReadonlySet<string>>(new Set())

export function suppressTabBar(key: string, on: boolean) {
  const next = new Set(tabBarSuppressed.value)
  if (on) next.add(key)
  else next.delete(key)
  tabBarSuppressed.value = next
}

/** The bar's height while it is on the page, for views sized to the window. */
export function tabBarHeight() {
  return (
    document.querySelector<HTMLElement>('[data-tab-bar-nav]')?.offsetHeight ?? 0
  )
}
