import { shallowRef } from 'vue'
import { appHref } from './app-path'
import type { RouteLocationRaw, Router } from 'vue-router'

/**
 * The public link (分享) the page shows, or '' in the owner's app. The
 * router sets it before each navigation; links to collections stay inside
 * the share while it is set, and reads go to its public API.
 */
export const shareSlug = shallowRef('')

/** Keep `shareSlug` on the public link each navigation shows, if any. */
export function followShare(router: Router) {
  router.beforeEach((to) => {
    shareSlug.value = to.meta.public ? String(to.params.slug) : ''
  })
}

/** The address of a collection, inside the share when one is open. */
export function collectionHref(id: string) {
  const path = `/collection/${encodeURIComponent(id)}`
  return appHref(shareSlug.value ? `/s/${shareSlug.value}${path}` : path)
}

/** A collection's page, or one of its own pages, as a route. */
export function collectionRoute(
  id: string,
  page?: 'stats' | 'changes' | 'follows' | 'graph',
): RouteLocationRaw {
  const name = page ? `collection-${page}` : 'collection'
  return shareSlug.value
    ? { name: `share-${name}`, params: { slug: shareSlug.value, id } }
    : { name, params: { id } }
}

/** The public address of a link, as the owner copies it. */
export function shareURL(slug: string) {
  return new URL(appHref(`/s/${slug}`), location.origin).href
}
