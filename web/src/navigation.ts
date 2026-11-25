import { host } from './host'
import { shareSlug } from './share'
import { backIsHistory, backPath } from './tab-state'
import { tabOf, tabRoute } from './tabbar'
import type {
  RouteLocationRaw,
  Router,
  RouteRecordNameGeneric,
} from 'vue-router'

/**
 * The start: what a public link opens, or the root of the tab the page
 * (`from`) belongs to, the library by default.
 */
export function homeRoute(from?: RouteRecordNameGeneric): RouteLocationRaw {
  if (shareSlug.value)
    return { name: 'share', params: { slug: shareSlug.value } }
  const tab = tabOf(from)
  return tab ? tabRoute(tab) : { name: 'collections' }
}

/**
 * Where 返回 leads (see `backPath`): the page before this one in its tab,
 * else the start.
 */
export function backRoute(router: Router): RouteLocationRaw {
  return backPath(router) ?? homeRoute(router.currentRoute?.value.name)
}

/**
 * 返回: a step back through history when that is where it leads. A page the
 * bottom bar brought back has another tab's page behind it in history, so
 * it replaces itself with the page before it in its own tab instead, and
 * the browser's back still returns to the other tab.
 */
export function goBack(router: Router) {
  if (backIsHistory(router)) router.back()
  else void router.replace(backRoute(router))
}

/**
 * Whether the Mini App runs this page. Telegram has no tabs to open a link
 * in, and a new browser window would not be signed in: every click
 * navigates here.
 */
export const inMiniApp = () => !!host()?.initData

/**
 * Whether a click on a link stays in this page: a plain left click, or any
 * click in the Mini App. A modified click (Cmd, Ctrl, Shift, Alt) or another
 * button is the browser's, to open a new tab or window.
 */
export function navigatesHere(event: MouseEvent) {
  if (inMiniApp()) return event.button === 0 || event.button === 1
  return (
    event.button === 0 &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !event.altKey
  )
}

/**
 * Open a route in a new tab, for what cannot be a link (a node drawn on a
 * canvas) when it is clicked the way a link opens in one: check
 * `navigatesHere` first.
 */
export function openInNewTab(router: Router, to: RouteLocationRaw) {
  window.open(router.resolve(to).href, '_blank', 'noopener')
}

/**
 * Route clicks on the app's own links (`#/…`) through the router. RouterLink
 * already does this for itself; plain anchors with a hash address rely on
 * it. Clicks the browser should open elsewhere are left alone, except in the
 * Mini App, where they navigate in place. Listen to both `click` and
 * `auxclick` (the middle button) on the document.
 */
export function followInternalLink(router: Router, event: MouseEvent) {
  if (event.defaultPrevented || !navigatesHere(event)) return
  const anchor =
    event.target instanceof Element ? event.target.closest('a') : null
  const href = anchor?.getAttribute('href')
  if (
    !anchor ||
    !href?.startsWith('#/') ||
    anchor.hasAttribute('download') ||
    (anchor.target && anchor.target !== '_self')
  )
    return
  event.preventDefault()
  void router.push(href.slice(1))
}
