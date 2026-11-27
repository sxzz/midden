import { Buffer } from 'node:buffer'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { matchedRoutes } from 'hono/route'
import { routeHas } from './markers.ts'
import type { Principal } from '#users/principal.ts'
import type { Env } from './validate.ts'
import type { Context, MiddlewareHandler } from 'hono'

const INIT_DATA_MAX_AGE = 300
const CLOCK_SKEW = 30
const HEX_HASH = /^[\da-f]{64}$/i

function signatureMatches(expected: Buffer, hash: string | undefined): boolean {
  if (!hash || !HEX_HASH.test(hash)) return false
  return timingSafeEqual(expected, Buffer.from(hash, 'hex'))
}

function fresh(authDate: string | undefined, maxAge: number, now: number) {
  const ts = Number(authDate)
  const seconds = Math.floor(now / 1000)
  return (
    Number.isSafeInteger(ts) &&
    ts <= seconds + CLOCK_SKEW &&
    ts >= seconds - maxAge
  )
}

/** The user id in Mini App initData, if Telegram signed it recently. */
export function initDataUser(
  raw: string,
  token: string,
  now = Date.now(),
): string | undefined {
  const params = new URLSearchParams(raw)
  const keys = [...new Set(params.keys())]
  if (keys.some((key) => params.getAll(key).length !== 1)) return undefined
  const check = keys
    .filter((key) => key !== 'hash')
    .toSorted()
    .map((key) => `${key}=${params.get(key)}`)
    .join('\n')
  const secret = createHmac('sha256', 'WebAppData').update(token).digest()
  const expected = createHmac('sha256', secret).update(check).digest()
  if (!signatureMatches(expected, params.get('hash') ?? undefined))
    return undefined
  if (!fresh(params.get('auth_date') ?? undefined, INIT_DATA_MAX_AGE, now))
    return undefined
  try {
    const id = JSON.parse(params.get('user') ?? '')?.id
    return Number.isSafeInteger(id) && id > 0 ? String(id) : undefined
  } catch {
    return undefined
  }
}

const SIGNED_IN = '只能在网页中登录后进行此操作'

/**
 * Routes that delete (收藏, 媒体, 所有视频, 标签, 收藏夹, 定期更新), add or
 * remove a domain, or manage users and invites: the admin's web session
 * only, never an API token, whatever its permission. `createApi` decides
 * what is a session.
 */
export const adminSession: MiddlewareHandler<Env> = async (c, next) => {
  const { role, via } = c.get('principal')
  if (role !== 'admin' || via !== 'session')
    return c.json({ error: SIGNED_IN }, 403)
  await next()
}

/**
 * Routes that make or change a way in (API tokens, web sessions, passkeys):
 * any user's web session, for their own rows only; never a token, so a
 * token cannot turn itself into a session.
 */
export const sessionOnly: MiddlewareHandler<Env> = async (c, next) => {
  if (c.get('principal').via !== 'session')
    return c.json({ error: SIGNED_IN }, 403)
  await next()
}

/**
 * Marks a route a viewer may call too (`.get('/collections', viewers, …)`),
 * as `inline` and `readOnly` mark theirs. Every other route refuses viewers
 * (`openToViewers`), so a new route nobody classified leaks nothing; the
 * routes that say it are listed in `viewers.test.ts`. What such a route
 * reads is filtered at its source by the principal (`ReadContext`).
 */
export const viewers: MiddlewareHandler = (_c, next) => next()

/**
 * Whether the request may go on: its principal is the admin, or its route
 * says `viewers`. `/v1` and the agent API both ask.
 */
export function openToViewers(c: Context): boolean {
  const { role } = c.get('principal') as Principal
  return role === 'admin' || routeHas(c, viewers)
}

/** What a viewer gets from a route not open to them. */
export const NOT_FOR_VIEWERS = '没有权限进行此操作'

/**
 * A read's context for this request: the process's, and whom it is for.
 * Library reads that differ by who asks take this, never the bare context.
 */
export function readCtx<T extends object>(
  ctx: T,
  c: Context<Env>,
): T & { principal: Principal } {
  return { ...ctx, principal: c.get('principal') }
}

/**
 * The route a request reached, as usage counts name it: the method and the
 * pattern (`GET /v1/collections/:id`), not the path with its ids.
 */
export function endpointOf(c: Context): string {
  const route = matchedRoutes(c).findLast(
    (r) => r.method !== 'ALL' && !r.path.endsWith('*'),
  )
  return `${c.req.method} ${route?.path ?? c.req.path}`
}
