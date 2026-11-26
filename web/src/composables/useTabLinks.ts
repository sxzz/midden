import { computed } from 'vue'
import { useRoute, useRouter, type RouteLocationRaw } from 'vue-router'
import { navigatesHere } from '../navigation'
import { lastPage, SWITCH_STATE, tabStates } from '../tab-state'
import { isTabRoot, tabOf, tabs, type Tab } from '../tabbar'

/**
 * The tabs' links, shared by the bottom bar and the desktop rail: which tab
 * is lit, where each one leads, and the tap on the open tab.
 */
export function useTabLinks() {
  const route = useRoute()
  const router = useRouter()
  const active = computed(() => tabOf(route.name))
  /**
   * Where each tab leads, which its link's address says too: another tab to
   * the page it was left on, the open one to its root (as last shown). The
   * entry is marked so 返回 there knows the reader did not come from the
   * page before it in history.
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
  /**
   * Tapping the tab already open: on its root, back to the top; deeper, its
   * link leads to the root. Listens on the links' container.
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
  return { active, links, tap }
}
