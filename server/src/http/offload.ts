// `GET /v1` requests run on the read threads by default: node:sqlite is
// synchronous, so one heavy read on the web process's own thread holds up
// every request behind it. The handler runs there as it would here, in the
// same API (`createApi`) built over the thread's read-only connection, and
// its response comes back as is. Handlers that need this process (its
// memory, the platforms, a write) or are trivially cheap say `inline`.
import { performance } from 'node:perf_hooks'
import { HTTPException } from 'hono/http-exception'
import { basePath, matchedRoutes } from 'hono/route'
import { PoolError, type QueryPool } from '#reads/pool.ts'
import type { TokenInfo } from '#tokens/tokens.ts'
import type { Env } from './validate.ts'
import type { Context, MiddlewareHandler } from 'hono'

/**
 * Marks a route to run on the web process's own thread: put it before the
 * handler, `.get('/session', inline, (c) => …)`.
 */
export const inline: MiddlewareHandler = (_c, next) => next()

/** A `GET` request as a read thread receives it. */
export interface ForwardedRequest {
  /** Where the API is mounted (`/v1`), so handlers see the same path. */
  base: string
  url: string
  headers: [string, string][]
  /** What the login middleware found, which the thread does not redo. */
  session: boolean
  token?: TokenInfo
}

export interface ForwardedResponse {
  status: number
  headers: [string, string][]
  body: ArrayBuffer
}

/** Where forwarded requests are answered. */
export interface WebReads {
  /** `onStart`: a thread took the request (it waited until then). */
  run: (
    request: ForwardedRequest,
    onStart?: () => void,
  ) => Promise<ForwardedResponse>
}

/** On the read threads of the pool, in its `web` lane. */
export function pooledWebReads(pool: QueryPool): WebReads {
  return {
    run: (request, onStart) =>
      pool.run(
        'web',
        'http',
        request,
        undefined,
        onStart,
      ) as Promise<ForwardedResponse>,
  }
}

/** How a request that ran on a read thread spent its time. */
export interface ThreadTiming {
  /** Waiting for a free thread. */
  waitMs: number
  /** On the thread, the read itself. */
  runMs: number
}

const threadTimings = new WeakMap<Request, ThreadTiming>()

/**
 * Whether this request ran on a read thread, and how long it waited and
 * ran there; undefined when it ran on the web process's own thread. The
 * web process's monitor (`load.ts`) keeps the two apart: only the latter
 * held up other requests.
 */
export function threadTiming(request: Request): ThreadTiming | undefined {
  return threadTimings.get(request)
}

/** Never forwarded: the login is checked here, and they are not reads. */
const PRIVATE_HEADERS = new Set(['authorization', 'cookie'])

/**
 * Whether the route this request reaches runs here. The first route that
 * matches answers it, so that route's handlers decide; a request no route
 * matches is answered here too.
 */
export function staysInline(c: Context): boolean {
  const routes = matchedRoutes(c)
  const first = routes.find((r) => r.method !== 'ALL')
  if (!first) return true
  return routes.some(
    (r) =>
      r.path === first.path && r.method === first.method && isInline(r.handler),
  )
}

/**
 * Mounted in an app with another error handler (`/v1` in the web process),
 * a route's handlers are wrapped; Hono keeps each one it wrapped.
 */
function isInline(handler: unknown): boolean {
  for (let h = handler; h; h = (h as Record<string, unknown>)[WRAPPED])
    if (h === inline) return true
  return false
}
const WRAPPED = '__COMPOSED_HANDLER'

/**
 * Forwards `GET` requests to the read threads unless their route is
 * `inline`. Without `reads` (tests, and the threads themselves) every
 * handler runs in place.
 */
export function offload(reads: WebReads | undefined): MiddlewareHandler<Env> {
  return async (c, next) => {
    if (!reads || c.req.method !== 'GET' || staysInline(c)) return next()
    let response: ForwardedResponse
    const asked = performance.now()
    let started: number | undefined
    try {
      response = await reads.run(
        {
          base: basePath(c),
          url: c.req.url,
          headers: [...c.req.raw.headers].filter(
            ([name]) => !PRIVATE_HEADERS.has(name),
          ),
          session: !!c.get('session'),
          ...(c.get('token') ? { token: c.get('token') } : {}),
        },
        () => (started = performance.now()),
      )
    } catch (error) {
      throw unavailable(error)
    } finally {
      const ended = performance.now()
      threadTimings.set(c.req.raw, {
        waitMs: (started ?? ended) - asked,
        runMs: ended - (started ?? ended),
      })
    }
    return new Response(response.body, {
      status: response.status,
      headers: response.headers,
    })
  }
}

/** What the web app sees when the pool could not run a read. */
function unavailable(error: unknown): unknown {
  if (!(error instanceof PoolError)) return error
  if (error.code === 'lost') return error
  return new HTTPException(503, {
    message: error.code === 'timeout' ? '查询超时' : '服务器繁忙，请重试',
  })
}
