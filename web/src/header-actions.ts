import { onActivated, onDeactivated, onUnmounted, shallowRef, watch } from 'vue'

/**
 * 刷新 for a page whose toolbar would hold nothing else (a 历史 tab's
 * 关注, 采集's records): it never gets a row of its own, but goes into the
 * page header's actions, left of the header's other icons. The page shown
 * publishes it; the header (CollectionLibrary's, PublicShare's) draws it.
 */
export interface HeaderRefresh {
  busy: boolean
  refresh: () => void
}

/** The shown page's 刷新 for the header; pages kept alive but hidden have none. */
export const headerRefresh = shallowRef<HeaderRefresh>()

/**
 * Publish a page's 刷新 to the header while the page is shown, following
 * `source` meanwhile; `undefined` when it has a toolbar of its own for it.
 */
export function useHeaderRefresh(source: () => HeaderRefresh | undefined) {
  let shown = true
  let mine: HeaderRefresh | undefined
  const publish = () => {
    mine = source()
    headerRefresh.value = mine
  }
  const withdraw = () => {
    // Another page may have published since; leave its button alone.
    if (headerRefresh.value === mine) headerRefresh.value = undefined
    mine = undefined
  }
  watch(source, () => shown && publish(), { immediate: true })
  onActivated(() => {
    shown = true
    publish()
  })
  onDeactivated(() => {
    shown = false
    withdraw()
  })
  onUnmounted(withdraw)
}
