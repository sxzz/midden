// Route markers: handlers that do nothing but say something about the
// route they are on (`inline`, `readOnly`, `viewers`), read back for the
// request that reached it.
import { matchedRoutes } from 'hono/route'
import type { Context, MiddlewareHandler } from 'hono'

/**
 * Whether the route this request reaches has `marker` among its handlers.
 * The first route that matches answers it, so that route's handlers decide.
 */
export function routeHas(c: Context, marker: MiddlewareHandler): boolean {
  const routes = matchedRoutes(c)
  const first = routes.find((r) => r.method !== 'ALL')
  if (!first) return false
  return routes.some(
    (r) =>
      r.path === first.path &&
      r.method === first.method &&
      isMarked(r.handler, marker),
  )
}

/**
 * Whether a route's handler (one of `app.routes`) is `marker`. Mounted in
 * an app with another error handler (`/v1` in the web process), a route's
 * handlers are wrapped; Hono keeps each one it wrapped.
 */
export function isMarked(handler: unknown, marker: MiddlewareHandler): boolean {
  for (let h = handler; h; h = (h as Record<string, unknown>)[WRAPPED])
    if (h === marker) return true
  return false
}
const WRAPPED = '__COMPOSED_HANDLER'
