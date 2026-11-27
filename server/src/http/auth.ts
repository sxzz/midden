import { Buffer } from 'node:buffer'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { matchedRoutes } from 'hono/route'
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

/**
 * Routes that delete (收藏, 媒体, 所有视频, 标签, 收藏夹, 定期更新, 通行密钥,
 * 域名) or manage API tokens and web sessions: the owner's web session
 * only, never an API token, whatever its permission. `createApi` decides
 * what is a session.
 */
export const ownerOnly: MiddlewareHandler<Env> = async (c, next) => {
  if (!c.get('session'))
    return c.json({ error: '只能在网页中登录后进行此操作' }, 403)
  await next()
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
