import type { RouteLocationRaw } from 'vue-router'

// Tests that mock vue-router still render links: `resolveHref` stands in for
// `router.resolve(to).href`, giving the hash address of the app's routes.

const PATHS: Record<string, string> = {
  collections: '/',
  folder: '/folder/:id',
  collection: '/collection/:id',
  'collection-stats': '/collection/:id/stats',
  'collection-changes': '/collection/:id/changes',
  'collection-follows': '/collection/:id/follows',
  'collection-graph': '/collection/:id/graph',
  compare: '/compare',
  relations: '/relations',
  settings: '/settings',
  'settings-section': '/settings/:section',
  'settings-entry': '/settings/:section/:entry',
  captures: '/captures',
  'captures-watches': '/captures/watches',
  capture: '/captures/:id',
  share: '/s/:slug',
  'share-collection': '/s/:slug/collection/:id',
  'share-collection-stats': '/s/:slug/collection/:id/stats',
  'share-collection-follows': '/s/:slug/collection/:id/follows',
  'share-collection-graph': '/s/:slug/collection/:id/graph',
  'share-collection-changes': '/s/:slug/collection/:id/changes',
}

export function resolveHref(to: RouteLocationRaw): string {
  if (typeof to === 'string') return `/app${to}`
  const named = to as {
    name?: string
    path?: string
    params?: Record<string, string>
    query?: Record<string, string | string[] | undefined>
  }
  const template = named.name ? PATHS[named.name] : named.path
  if (template === undefined) throw new Error(`no route ${named.name}`)
  // Optional parameters left out leave no segment, as the router's.
  const path =
    template
      .replaceAll(/:(\w+)/g, (_, key: string) =>
        encodeURIComponent(named.params?.[key] ?? ''),
      )
      .replaceAll(/\/+(?=\/|$)/g, '') || '/'
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(named.query ?? {}))
    for (const item of [value ?? []].flat()) query.append(key, item)
  return `/app${path}${query.size ? `?${query}` : ''}`
}

/** `router.resolve` of the mocked router. */
export const resolve = (to: RouteLocationRaw) => ({ href: resolveHref(to) })
