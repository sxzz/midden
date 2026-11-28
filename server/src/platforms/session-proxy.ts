import {
  buildConnector,
  Pool,
  ProxyAgent,
  Socks5ProxyAgent,
  type Dispatcher,
} from 'undici'
import { Metadata, status } from './rpc.ts'
import type { Logger } from '#log.ts'

/**
 * Requests that carry a capture account's session (its cookies and tokens)
 * leave through `SESSION_PROXY` when it is set, so the platform sees them
 * come from the address the account is used from, not a datacenter's.
 * Platform code wraps the fetcher of each such request in `sessionFetch()`
 * where it attaches the credentials; public requests (FxTwitter, media
 * servers, R2, Telegram) never do and go direct. A proxy that cannot be
 * reached fails the request (`SessionProxyError`): it is never sent direct
 * instead.
 */

/** The error kind of a session request the proxy could not carry. */
export const SESSION_PROXY_UNREACHABLE = 'session_proxy_unreachable'

// How long reaching the proxy may take, and the startup probe as a whole.
const CONNECT_TIMEOUT = 10_000
const PROBE_TIMEOUT = 15_000
// The probe asks this without credentials: whether the proxy reaches X.
const PROBE_URL = 'https://x.com/'

/** A session request that did not go out because the proxy failed. */
export class SessionProxyError extends Error {
  override name = 'SessionProxyError'
  readonly code = status.UNAVAILABLE
  readonly metadata = new Metadata()
  readonly details = { kind: SESSION_PROXY_UNREACHABLE }
  constructor(cause: unknown) {
    super('采集账号代理不可达', { cause })
  }
}

export const isSessionProxyError = (
  error: unknown,
): error is SessionProxyError => error instanceof SessionProxyError

const viaProxy = Symbol('session proxy connect')

/** Marks the errors of connecting to the proxy itself. */
function marked(connect: buildConnector.connector): buildConnector.connector {
  return (options, callback) =>
    connect(options, (error, socket) => {
      if (error) {
        ;(error as unknown as Record<symbol, boolean>)[viaProxy] = true
        callback(error, null)
      } else callback(null, socket!)
    })
}

/** The proxy failed (unreachable, refused the tunnel), not the platform. */
export function proxyFailure(error: unknown): boolean {
  let e: any = error
  for (let depth = 0; e && typeof e === 'object' && depth < 8; depth++) {
    if (e[viaProxy]) return true
    const code = typeof e.code === 'string' ? e.code : ''
    if (
      code === 'UND_ERR_PRX_CONN' ||
      code === 'UND_ERR_PRX_TLS' ||
      code.startsWith('UND_ERR_SOCKS5') ||
      /^Proxy response \(\d+\) !== 200/.test(String(e.message))
    )
      return true
    e = e.cause
  }
  return false
}

/** What went wrong, for the logs: the innermost error's code or message. */
function reason(error: unknown): string {
  let e: any = error
  while (e?.cause && typeof e.cause === 'object') e = e.cause
  return typeof e?.code === 'string' && e.code
    ? e.code
    : String(e?.message ?? e).slice(0, 200)
}

/** A dispatcher that sends every request through the proxy at `url`. */
export function proxyDispatcher(url: string): Dispatcher {
  if (new URL(url).protocol === 'socks5:')
    return new Socks5ProxyAgent(url, {
      // Used only to reach the proxy; the platform's TLS is its own.
      connect: marked(buildConnector({ timeout: CONNECT_TIMEOUT })),
      connectTimeout: CONNECT_TIMEOUT,
    })
  return new ProxyAgent({
    uri: url,
    // Tunnel plain http too, so the proxy only ever sees CONNECT.
    proxyTunnel: true,
    connectTimeout: CONNECT_TIMEOUT,
    clientFactory: (origin, options) =>
      new Pool(origin, {
        ...options,
        connect: marked(
          (options as { connect: buildConnector.connector }).connect,
        ),
      }),
  })
}

interface Route {
  dispatcher: Dispatcher
  /** The proxy's URL; it holds no credentials (`#config.ts`). */
  proxy: string
  logger?: Logger
}

let route: Route | undefined

/**
 * Send session requests through the proxy at `url` from now on. Returns how
 * to stop: session requests go direct again and the proxy's connections
 * close.
 */
export function useSessionProxy(url: string, logger?: Logger): () => void {
  const current: Route = {
    dispatcher: proxyDispatcher(url),
    proxy: url,
    logger,
  }
  route = current
  return () => {
    if (route === current) route = undefined
    current.dispatcher.destroy().catch(() => {})
  }
}

/**
 * `fetcher` as a request with the account's session must use: through the
 * proxy when one is configured, else `fetcher` itself.
 */
export function sessionFetch(fetcher: typeof fetch): typeof fetch {
  const current = route
  if (!current) return fetcher
  return async (input, init) => {
    try {
      return await fetcher(input, {
        ...init,
        dispatcher: current.dispatcher,
      } as RequestInit)
    } catch (error) {
      if (!proxyFailure(error)) throw error
      const url = input instanceof Request ? input.url : String(input)
      current.logger?.warn(
        {
          errorCode: SESSION_PROXY_UNREACHABLE,
          proxy: current.proxy,
          host: URL.canParse(url) ? new URL(url).hostname : undefined,
          reason: reason(error),
        },
        'session proxy unreachable; the session request was not sent',
      )
      throw new SessionProxyError(error)
    }
  }
}

/**
 * Whether the configured proxy reaches X: one HEAD request through it,
 * without credentials. Logged, never thrown: a proxy that is down only
 * fails session requests until it is back.
 */
export async function checkSessionProxy(
  logger: Logger,
  fetcher: typeof fetch = fetch,
  url = PROBE_URL,
): Promise<boolean> {
  const current = route
  if (!current) return false
  try {
    const response = await fetcher(url, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT),
      dispatcher: current.dispatcher,
    } as RequestInit)
    await response.body?.cancel()
    logger.info(
      { proxy: current.proxy, status: response.status },
      'session proxy reachable',
    )
    return true
  } catch (error) {
    logger.warn(
      {
        errorCode: SESSION_PROXY_UNREACHABLE,
        proxy: current.proxy,
        reason: reason(error),
      },
      'session proxy unreachable at startup; session requests fail until it is back',
    )
    return false
  }
}
