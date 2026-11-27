// `GET /v1` requests run on the read threads by default: node:sqlite is
// synchronous, so one heavy read on the web process's own thread holds up
// every request behind it. The handler runs there as it would here, in the
// same API (`createApi`) built over the thread's read-only connection, and
// its response comes back as is. Handlers that need this process (its
// memory, the platforms, a write) or are trivially cheap say `inline`. Dry
// runs, which are `POST` only for their JSON body, say `readOnly` and run
// there too. Writes stay here, and run what they read beforehand or answer
// afterwards on a thread (`WebReads.read`).
import { performance } from 'node:perf_hooks'
import { HTTPException } from 'hono/http-exception'
import { basePath, matchedRoutes } from 'hono/route'
import {
  runRead,
  type ReadInput,
  type ReadName,
  type ReadOutput,
} from '#agent/reads.ts'
import { AppError } from '#errors.ts'
import { PoolError, ThreadError, type QueryPool } from '#reads/pool.ts'
import type { AgentReader } from '#agent/query.ts'
import type { TokenInfo } from '#tokens/tokens.ts'
import type { Env } from './validate.ts'
import type { Context, MiddlewareHandler } from 'hono'

/**
 * Marks a route to run on the web process's own thread: put it before the
 * handler, `.get('/session', inline, (c) => …)`.
 */
export const inline: MiddlewareHandler = (_c, next) => next()

/**
 * Marks a route that is not a `GET` as a read: a dry run that takes its
 * input as a JSON body (`.post('/updates/preview', readOnly, …)`). It runs
 * on the read threads as a `GET` does, and counts as a read elsewhere too: a
 * read-only token may call it, and it is no write the threads hear of. Its
 * handler must never write; on a thread it cannot.
 */
export const readOnly: MiddlewareHandler = (_c, next) => next()

/** A request as a read thread receives it. */
export interface ForwardedRequest {
  /** Where the API is mounted (`/v1`), so handlers see the same path. */
  base: string
  method: string
  url: string
  headers: [string, string][]
  /** A `readOnly` route's JSON body. */
  body?: ArrayBuffer
  /** What the login middleware found, which the thread does not redo. */
  session: boolean
  token?: TokenInfo
}

export interface ForwardedResponse {
  status: number
  headers: [string, string][]
  body: ArrayBuffer
}

/** A read by name (`agent/reads.ts`). */
export type NamedRead = <N extends ReadName>(
  name: N,
  input: ReadInput<N>,
) => Promise<ReadOutput<N>>

/** Where forwarded requests are answered. */
export interface WebReads {
  /** `onStart`: a thread took the request (it waited until then). */
  run: (
    request: ForwardedRequest,
    onStart?: () => void,
  ) => Promise<ForwardedResponse>
  /**
   * A read there for a write: what it is to change (an update's members,
   * the media a removal takes), or what it answers once written. What the
   * read throws is thrown here as it was there.
   */
  read: NamedRead
}

/** On the read threads of the pool, in its `web` lane. */
export function pooledWebReads(pool: QueryPool): WebReads {
  return {
    read: (async (name: string, input: unknown) => {
      try {
        return await pool.run('web', name, input)
      } catch (error) {
        throw unavailable(error)
      }
    }) as NamedRead,
    run: (request, onStart) =>
      pool.run(
        'web',
        'http',
        request,
        request.body ? [request.body] : undefined,
        onStart,
      ) as Promise<ForwardedResponse>,
  }
}

/**
 * Reads by name where the API runs them: on the threads when the web process
 * has them, else in place (tests, and the threads themselves), the result
 * copied as a thread's would be.
 */
export function namedReads(
  reads: WebReads | undefined,
  reader: () => AgentReader,
): NamedRead {
  if (reads) return reads.read
  return ((name: ReadName, input: unknown) => {
    // What it throws is a rejection, as from a thread.
    try {
      return Promise.resolve(structuredClone(runRead(reader(), name, input)))
    } catch (error) {
      return Promise.reject(error)
    }
  }) as NamedRead
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
 * Whether the route this request reaches has `marker` among its handlers.
 * The first route that matches answers it, so that route's handlers decide.
 */
function routeHas(c: Context, marker: MiddlewareHandler): boolean {
  const routes = matchedRoutes(c)
  const first = routes.find((r) => r.method !== 'ALL')
  if (!first) return false
  return routes.some(
    (r) =>
      r.path === first.path &&
      r.method === first.method &&
      wraps(r.handler, marker),
  )
}

/**
 * Whether the route this request reaches runs here: it says `inline`, or no
 * route matches.
 */
export function staysInline(c: Context): boolean {
  return (
    matchedRoutes(c).every((r) => r.method === 'ALL') || routeHas(c, inline)
  )
}

/** Whether the request only reads: a `GET`, or its route says `readOnly`. */
export function onlyReads(c: Context): boolean {
  return READ_METHODS.has(c.req.method) || routeHas(c, readOnly)
}
const READ_METHODS = new Set(['GET', 'HEAD'])

/**
 * Mounted in an app with another error handler (`/v1` in the web process),
 * a route's handlers are wrapped; Hono keeps each one it wrapped.
 */
function wraps(handler: unknown, marker: MiddlewareHandler): boolean {
  for (let h = handler; h; h = (h as Record<string, unknown>)[WRAPPED])
    if (h === marker) return true
  return false
}
const WRAPPED = '__COMPOSED_HANDLER'

/** Whether the request goes to the read threads. */
function forwarded(c: Context): boolean {
  if (c.req.method === 'GET') return !staysInline(c)
  return routeHas(c, readOnly)
}

/**
 * Forwards `GET` requests to the read threads unless their route is
 * `inline`, and those whose route is `readOnly`. Without `reads` (tests,
 * and the threads themselves) every handler runs in place.
 */
export function offload(reads: WebReads | undefined): MiddlewareHandler<Env> {
  return async (c, next) => {
    if (!reads || !forwarded(c)) return next()
    let response: ForwardedResponse
    const asked = performance.now()
    let started: number | undefined
    const body =
      c.req.method === 'GET' ? undefined : await c.req.raw.arrayBuffer()
    try {
      response = await reads.run(
        {
          base: basePath(c),
          method: c.req.method,
          url: c.req.url,
          headers: [...c.req.raw.headers].filter(
            ([name]) => !PRIVATE_HEADERS.has(name),
          ),
          ...(body?.byteLength ? { body } : {}),
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
  // A read for a write threw it: as if thrown here.
  if (error instanceof ThreadError && error.app)
    return new AppError(error.app.kind, error.app.message)
  if (!(error instanceof PoolError)) return error
  if (error.code === 'lost') return error
  return new HTTPException(503, {
    message: error.code === 'timeout' ? '查询超时' : '服务器繁忙，请重试',
  })
}
