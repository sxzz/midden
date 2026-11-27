import { computed } from 'vue'
import { useRoute, useRouter, type RouteLocationRaw } from 'vue-router'
import { navigatesHere } from '../navigation'
import { lastPage, RESET_STATE, SWITCH_STATE, tabStates } from '../tab-state'
import { tabOf, tabs, type Tab } from '../tabbar'

/**
 * The tabs' links, shared by the bottom bar and the desktop rail: which tab
 * is lit, where each one leads, and the tap on the open tab.
 */
export function useTabLinks() {
  const route = useRoute()
  const router = useRouter()
  const active = computed(() => tabOf(route.name))
  /** A tab's root with nothing in its address: what tapping it again resets
      it to. */
  const plainRoot = (tab: Tab) => tabs.find((t) => t.value === tab)!.path
  /**
   * Where each tab leads, which its link's address says too: another tab to
   * the page it was left on (the entry marked so 返回 there knows the reader
   * did not come from the page before it in history); the open one to its
   * plain root, which resets the tab (its saved state follows, see
   * tab-state).
   */
  function linkTo(tab: Tab): RouteLocationRaw {
    if (tab === active.value)
      return { path: plainRoot(tab), state: RESET_STATE }
    // History state rides only on a location object, whose `path` cannot
    // carry the query.
    const { path, query, hash } = router.resolve(lastPage(tabStates.value, tab))
    return { path, query, hash, state: SWITCH_STATE }
  }
  const links = computed(
    () =>
      Object.fromEntries(
        tabs.map(({ value }) => [value, linkTo(value)]),
      ) as Record<Tab, RouteLocationRaw>,
  )
  /**
   * Tapping the tab already open: already on its plain root, back to the
   * top; anywhere else (deeper, or the root with a query, filters or a
   * folder), its link resets it. Listens on the links' container.
   */
  function tap(event: MouseEvent) {
    const link =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>('[data-tab]')
        : null
    const tab = active.value
    if (
      !link ||
      !tab ||
      link.dataset.tab !== tab ||
      route.fullPath !== plainRoot(tab) ||
      !navigatesHere(event)
    )
      return
    event.preventDefault()
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  return { active, links, tap }
}
