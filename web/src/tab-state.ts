import { shallowRef } from 'vue'
import { isTabRoot, tabOf, tabs, type Tab } from './tabbar'
import type { RouteLocationNormalized, Router } from 'vue-router'

/**
 * Where each tab of the bottom bar was left, as X keeps it: switching away
 * and back returns to the same page at the same scroll, and 返回 there goes
 * where it would have gone had the reader never left.
 */
export interface TabState {
  /** The tab's root as last shown, with its filters. */
  root: string
  /**
   * The pages opened in the tab, oldest first, ending with the one it was
   * left on. Each one's 返回 leads to the one before it; the first may be a
   * page of another tab that opened it (a graph node opens its 探索 detail).
   */
  stack: string[]
  /** How far the last page was scrolled when it was left. */
  scroll: number
}
export type TabStates = Record<Tab, TabState>

/**
 * How a page was reached. `switch` is the bar's own link to a tab as it was
 * left; `back` a step back through the browser's history.
 */
export type Move = 'push' | 'switch' | 'replace' | 'back' | 'load'

export interface Visit {
  tab: Tab
  path: string
  /** Whether the page is the tab's root. */
  root: boolean
  move: Move
  /** The page left, unless this is the first. */
  from?: { tab?: Tab; path: string }
}

/** A long session's chain is cut from its oldest end. */
const DEPTH = 30

export function emptyStates(): TabStates {
  return Object.fromEntries(
    tabs.map((tab) => [
      tab.value,
      { root: tab.path, stack: [tab.path], scroll: 0 },
    ]),
  ) as TabStates
}

/** The tab states after a page of `visit.tab` is shown. */
export function visit(states: TabStates, v: Visit): TabStates {
  const state = states[v.tab]
  const top = state.stack.at(-1)
  let { root, stack } = state
  if (v.root) {
    root = v.path
    stack = [v.path]
  } else if (v.move === 'switch') {
    if (top !== v.path) stack = [v.path]
  } else if (v.move === 'push') {
    if (v.from?.tab === v.tab) stack = [...stack, v.path]
    // Opened from another tab's page: 返回 leads back there.
    else stack = v.from ? [v.from.path, v.path] : [v.path]
  } else {
    // Back, a reload, or an address replaced: a page already in the chain
    // cuts it there; a replaced one takes the place of the last.
    const at = stack.lastIndexOf(v.path)
    if (at !== -1) stack = stack.slice(0, at + 1)
    else if (v.move === 'replace' && v.from?.tab === v.tab)
      stack = [...stack.slice(0, -1), v.path]
    else stack = [v.path]
  }
  if (stack.length > DEPTH) stack = stack.slice(-DEPTH)
  if (root === state.root && stack === state.stack) return states
  const scroll = stack.at(-1) === top ? state.scroll : 0
  return { ...states, [v.tab]: { root, stack, scroll } }
}

/** Record how far the page a tab was left on had been scrolled. */
export function leave(
  states: TabStates,
  tab: Tab,
  path: string,
  scroll: number,
): TabStates {
  const state = states[tab]
  if (state.stack.at(-1) !== path || state.scroll === scroll) return states
  return { ...states, [tab]: { ...state, scroll } }
}

/** Forget pages that no longer exist, such as a deleted collection's. */
export function forget(
  states: TabStates,
  gone: (path: string) => boolean,
): TabStates {
  let next = states
  for (const tab of tabs) {
    const state = states[tab.value]
    const stack = state.stack.filter((path) => !gone(path))
    if (stack.length === state.stack.length) continue
    const top = stack.at(-1)
    next = {
      ...next,
      [tab.value]: {
        root: gone(state.root) ? tab.path : state.root,
        stack: stack.length ? stack : [state.root],
        scroll: top === state.stack.at(-1) ? state.scroll : 0,
      },
    }
  }
  return next
}

/** Where 返回 on a tab's last page leads: the page before it, or the root. */
export function backTarget(states: TabStates, tab: Tab) {
  const { stack, root } = states[tab]
  return stack.length > 1 ? stack.at(-2)! : root
}

/** The page a tab was left on. */
export function lastPage(states: TabStates, tab: Tab) {
  return states[tab].stack.at(-1)!
}

/** The scroll to restore for `path`, if it is where its tab was left. */
export function leftScroll(states: TabStates, tab: Tab, path: string) {
  return lastPage(states, tab) === path ? states[tab].scroll : undefined
}

// Kept for the browser tab's session: a reload returns to the same places,
// a new window starts over.
const KEY = 'midden.tabs'

export function readStates(): TabStates {
  const states = emptyStates()
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? 'null')
    if (!saved || typeof saved !== 'object') return states
    for (const tab of tabs) {
      const value = (saved as Record<string, Partial<TabState>>)[tab.value]
      if (
        typeof value?.root === 'string' &&
        Array.isArray(value.stack) &&
        value.stack.length &&
        value.stack.every((path) => typeof path === 'string') &&
        typeof value.scroll === 'number'
      )
        states[tab.value] = {
          root: value.root,
          stack: value.stack,
          scroll: value.scroll,
        }
    }
  } catch {
    // Unreadable or off: every tab starts at its root.
  }
  return states
}

function writeStates(states: TabStates) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(states))
  } catch {
    // Storage can be off; the tabs are then remembered until a reload.
  }
}

export const tabStates = shallowRef<TabStates>(readStates())

function update(next: TabStates) {
  if (next === tabStates.value) return
  tabStates.value = next
  writeStates(next)
}

/** The history entry state the bar's links carry, see `Move`. */
export const SWITCH_STATE = { tabSwitch: true }

/** Whether the shown history entry was reached through the bar. */
const switched = (router: Router) =>
  router.options.history.state.tabSwitch === true

/**
 * Where 返回 leads from the page shown: back through history when that is
 * the page before it in its tab, as it is unless the bar brought it back;
 * else that page, or the tab's root.
 */
export function backPath(router: Router): string | undefined {
  const route = router.currentRoute?.value
  const tab = tabOf(route?.name)
  const back = router.options.history.state.back
  if (route && tab && (switched(router) || typeof back !== 'string')) {
    const states = tabStates.value
    return lastPage(states, tab) === route.fullPath
      ? backTarget(states, tab)
      : states[tab].root
  }
  return typeof back === 'string' ? back : undefined
}

/** Whether 返回 from the page shown is a step back through history. */
export function backIsHistory(router: Router) {
  const back = router.options.history.state.back
  return typeof back === 'string' && backPath(router) === back
}

export function forgetPages(gone: (path: string) => boolean) {
  update(forget(tabStates.value, gone))
}

/**
 * Follow the owner's navigation into the tab states, from the first page
 * on. Call once, before the router's first navigation.
 */
export function trackTabs(router: Router) {
  let popped: 'back' | 'forward' | undefined
  router.options.history.listen((_to, _from, info) => {
    popped = info.direction === 'back' ? 'back' : 'forward'
  })
  const saveScroll = (route: RouteLocationNormalized) => {
    const tab = tabOf(route.name)
    if (tab) update(leave(tabStates.value, tab, route.fullPath, window.scrollY))
  }
  router.beforeEach((_to, from) => {
    if (from.matched.length) saveScroll(from)
  })
  router.afterEach((to, from, failure) => {
    const pop = popped
    popped = undefined
    const tab = tabOf(to.name)
    if (failure || !tab) return
    const first = !from.matched.length
    const state = router.options.history.state
    const move: Move = first
      ? 'load'
      : pop === 'back'
        ? 'back'
        : state.tabSwitch === true && !state.replaced
          ? 'switch'
          : !pop && state.replaced
            ? 'replace'
            : 'push'
    update(
      visit(tabStates.value, {
        tab,
        path: to.fullPath,
        root: isTabRoot(to.name),
        move,
        from: first
          ? undefined
          : { tab: tabOf(from.name), path: from.fullPath },
      }),
    )
  })
  // A reload or a closed tab: keep how far the page was scrolled.
  const hide = () => saveScroll(router.currentRoute.value)
  window.addEventListener('pagehide', hide)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') hide()
  })
}
