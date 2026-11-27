import { tabOf } from './tabbar'
import { can } from './user'
import type {
  RouteLocationNormalized,
  RouteLocationRaw,
  Router,
} from 'vue-router'

/**
 * Where a page the signed-in user has no use for leads instead, or
 * nothing when they may open it: 采集 is for whoever captures, 管理员面板
 * for the admin's session. The server refuses their requests anyway.
 */
export function redirectFor(
  to: Pick<RouteLocationNormalized, 'name' | 'params'>,
): RouteLocationRaw | undefined {
  if (tabOf(to.name) === 'captures' && !can.capture) return '/'
  if (to.params.section === 'admin' && !can.admin) return '/settings'
  return undefined
}

let guarded = false
/** Keep the user to their own pages, from the one shown now on. */
export async function guardPages(router: Router) {
  if (!guarded) router.beforeEach((to) => redirectFor(to) ?? true)
  guarded = true
  const away = redirectFor(router.currentRoute.value)
  if (away) await router.replace(away)
}
