import type { Context, MiddlewareHandler } from 'hono'

/**
 * A fixed-window limit per client and one for everyone together. The client
 * is told apart by the proxy's address headers, which a caller can forge;
 * the shared limit still caps the total.
 */
export function rateLimit(options: {
  perClient: number
  total: number
  windowMs: number
  now?: () => number
}): MiddlewareHandler {
  const now = options.now ?? Date.now
  let windowStart = 0
  let total = 0
  const clients = new Map<string, number>()
  return async (c, next) => {
    const time = now()
    if (time - windowStart >= options.windowMs) {
      windowStart = time
      total = 0
      clients.clear()
    }
    const key = clientKey(c)
    const used = clients.get(key) ?? 0
    if (used >= options.perClient || total >= options.total)
      return c.json({ error: '请求过于频繁，请稍后重试' }, 429)
    clients.set(key, used + 1)
    total++
    await next()
  }
}

function clientKey(c: Context): string {
  return (
    c.req.header('CF-Connecting-IP') ??
    c.req.header('X-Forwarded-For')?.split(',', 1)[0]?.trim() ??
    ''
  )
}
