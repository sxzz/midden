import { shareSlug } from './share'
import type { Router } from 'vue-router'

/** Back, or to the start: the library, or what a public link opens. */
export function goBack(router: Router) {
  if (router.options.history.state.back) router.back()
  else if (shareSlug.value)
    void router.replace({ name: 'share', params: { slug: shareSlug.value } })
  else void router.replace({ name: 'collections' })
}

/** Preserve native new-tab gestures while keeping ordinary hash links in router history. */
export function followInternalLink(router: Router, event: MouseEvent) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    event.altKey
  )
    return
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
