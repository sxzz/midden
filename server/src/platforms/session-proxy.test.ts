import http from 'node:http'
import net, { type AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { errorCode } from '#capture/errors.ts'
import { levels, recordingLogger } from '#testing/logs.ts'
import { InstagramClient } from './instagram/client.ts'
import { isProviderFailure } from './platform.ts'
import { status } from './rpc.ts'
import {
  checkSessionProxy,
  isSessionProxyError,
  SESSION_PROXY_UNREACHABLE,
  sessionFetch,
  useSessionProxy,
} from './session-proxy.ts'
import { accountBootstrap } from './x/bootstrap.ts'
import { identifyHandle } from './x/identify.ts'
import { accountTransport } from './x/session.ts'

const credential = { authToken: 'a'.repeat(40), csrfToken: 'c'.repeat(32) }
const signer = () =>
  Promise.resolve({ generateTransactionId: () => Promise.resolve('tx') })

/** Plain HTTP standing in for the platform: whatever the proxy tunnels to. */
interface Target {
  port: number
  requests: { url: string; cookie?: string }[]
}

/** A CONNECT proxy that tunnels every request to `target`, or refuses. */
interface Proxy {
  url: string
  connects: string[]
  refuse: boolean
}

const closing: (() => Promise<void>)[] = []
let stopProxy: (() => void) | undefined
let target: Target
let proxy: Proxy

function listen(server: net.Server): Promise<number> {
  closing.push(
    () =>
      new Promise((resolve) => {
        if ('closeAllConnections' in server)
          (server as http.Server).closeAllConnections()
        server.close(() => resolve())
      }),
  )
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve((server.address() as AddressInfo).port),
    ),
  )
}

async function startTarget(): Promise<Target> {
  const requests: Target['requests'] = []
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url!, cookie: req.headers.cookie })
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({ data: { ok: true }, code: 200, user: { id: '42' } }),
    )
  })
  return { port: await listen(server), requests }
}

async function startProxy(to: Target): Promise<Proxy> {
  const sockets = new Set<net.Socket>()
  const state: Proxy = { url: '', connects: [], refuse: false }
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('data', (head) => {
      const line = head.toString('latin1').split('\r\n', 1)[0]!
      state.connects.push(line)
      if (state.refuse || !line.startsWith('CONNECT ')) {
        socket.end('HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n')
        return
      }
      const upstream = net.connect(to.port, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        socket.pipe(upstream).pipe(socket)
      })
      upstream.on('error', () => socket.destroy())
      sockets.add(upstream)
    })
  })
  closing.push(async () => {
    for (const s of sockets) s.destroy()
  })
  state.url = `http://127.0.0.1:${await listen(server)}`
  return state
}

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = net.createServer()
  const port = await new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve((server.address() as AddressInfo).port),
    ),
  )
  await new Promise((resolve) => server.close(resolve))
  return port
}

/** Records each call and whether it carried a dispatcher (the proxy). */
function spy(fetcher: typeof fetch = fetch) {
  const calls: { url: string; proxied: boolean }[] = []
  const wrapped: typeof fetch = (input, init) => {
    calls.push({
      url: input instanceof Request ? input.url : String(input),
      proxied: !!(init as { dispatcher?: unknown } | undefined)?.dispatcher,
    })
    return fetcher(input, init)
  }
  return { fetcher: wrapped, calls }
}

beforeEach(async () => {
  target = await startTarget()
  proxy = await startProxy(target)
})

afterEach(async () => {
  stopProxy?.()
  stopProxy = undefined
  for (const close of closing.splice(0).toReversed()) await close()
})

describe('with SESSION_PROXY set', () => {
  test('an X session request goes through the proxy, cookies and all', async () => {
    stopProxy = useSessionProxy(proxy.url)
    const transport = accountTransport(credential, AbortSignal.timeout(5000), {
      target: 'api',
      transactions: signer,
    })!
    const response = await transport.fetch(
      'http://api.x.com/graphql/abc/Viewer?variables=%7B%7D',
    )
    expect(await response.json()).toEqual(
      expect.objectContaining({ data: { ok: true } }),
    )
    expect(proxy.connects).toEqual(['CONNECT api.x.com:80 HTTP/1.1'])
    expect(target.requests).toEqual([
      {
        url: '/graphql/abc/Viewer?variables=%7B%7D',
        cookie: `auth_token=${credential.authToken}; ct0=${credential.csrfToken}`,
      },
    ])
  })

  test('the X account page and Instagram ask the proxy for their hosts', async () => {
    stopProxy = useSessionProxy(proxy.url)
    // Refused, so the TLS the platforms need never starts; what was asked
    // for is the point.
    proxy.refuse = true
    await expect(
      accountBootstrap(credential, AbortSignal.timeout(5000)),
    ).rejects.toSatisfy(isSessionProxyError)
    const instagram = new InstagramClient(AbortSignal.timeout(5000), {
      sessionId: 's'.repeat(20),
      csrfToken: 'c'.repeat(20),
      userId: '77',
    })
    await expect(instagram.checkConnection()).rejects.toSatisfy(
      isSessionProxyError,
    )
    expect(proxy.connects).toEqual([
      'CONNECT x.com:443 HTTP/1.1',
      'CONNECT www.instagram.com:443 HTTP/1.1',
    ])
    expect(target.requests).toEqual([])
  })

  test('public requests go direct', async () => {
    stopProxy = useSessionProxy(proxy.url)
    const { fetcher, calls } = spy()
    const id = await identifyHandle(
      'someone',
      AbortSignal.timeout(5000),
      undefined,
      {
        fetcher,
        endpoint: `http://127.0.0.1:${target.port}/2/profile`,
      },
    )
    expect(id).toBe('42')
    expect(calls).toEqual([
      {
        url: `http://127.0.0.1:${target.port}/2/profile/someone`,
        proxied: false,
      },
    ])
    expect(proxy.connects).toEqual([])
    expect(target.requests).toHaveLength(1)
  })

  test('a proxy that cannot be reached fails the request, which never goes direct', async () => {
    const { logger, entries } = recordingLogger()
    stopProxy = useSessionProxy(
      `http://127.0.0.1:${await closedPort()}`,
      logger,
    )
    const { fetcher, calls } = spy()
    const transport = accountTransport(credential, AbortSignal.timeout(5000), {
      target: 'api',
      fetcher,
      transactions: signer,
    })!
    const error = await transport
      .fetch(`http://api.x.com/graphql/abc/Viewer`)
      .catch((e: unknown) => e)
    expect(isSessionProxyError(error)).toBe(true)
    // Transient, as the platforms' own failures: the job tries again.
    expect(isProviderFailure(error) && error.code).toBe(status.UNAVAILABLE)
    expect(errorCode(error)).toBe(SESSION_PROXY_UNREACHABLE)
    expect(calls).toEqual([
      { url: 'http://api.x.com/graphql/abc/Viewer', proxied: true },
    ])
    expect(target.requests).toEqual([])
    expect(entries).toContainEqual(
      expect.objectContaining({
        level: levels.warn,
        errorCode: SESSION_PROXY_UNREACHABLE,
        host: 'api.x.com',
        reason: 'ECONNREFUSED',
        msg: 'session proxy unreachable; the session request was not sent',
      }),
    )
  })

  test('a refused tunnel fails the request as unreachable', async () => {
    stopProxy = useSessionProxy(proxy.url)
    proxy.refuse = true
    await expect(
      accountTransport(credential, AbortSignal.timeout(5000), {
        target: 'api',
        transactions: signer,
      })!.fetch('http://api.x.com/graphql/abc/Viewer'),
    ).rejects.toSatisfy(isSessionProxyError)
    expect(target.requests).toEqual([])
  })

  test('a SOCKS5 proxy that cannot be reached fails the same way', async () => {
    stopProxy = useSessionProxy(`socks5://127.0.0.1:${await closedPort()}`)
    await expect(
      accountTransport(credential, AbortSignal.timeout(5000), {
        target: 'api',
        transactions: signer,
      })!.fetch('http://api.x.com/graphql/abc/Viewer'),
    ).rejects.toSatisfy(isSessionProxyError)
  })

  test('the startup check logs whether the proxy is reachable', async () => {
    const { logger, entries } = recordingLogger()
    stopProxy = useSessionProxy(proxy.url)
    expect(await checkSessionProxy(logger, fetch, 'http://x.com/')).toBe(true)
    expect(proxy.connects).toEqual(['CONNECT x.com:80 HTTP/1.1'])
    // Without credentials.
    expect(target.requests).toEqual([{ url: '/', cookie: undefined }])
    stopProxy()
    stopProxy = useSessionProxy(`http://127.0.0.1:${await closedPort()}`)
    expect(await checkSessionProxy(logger, fetch, 'http://x.com/')).toBe(false)
    expect(entries.map((e) => [e.level, e.msg])).toEqual([
      [levels.info, 'session proxy reachable'],
      [
        levels.warn,
        'session proxy unreachable at startup; session requests fail until it is back',
      ],
    ])
  })
})

describe('without SESSION_PROXY', () => {
  test('session requests use the given fetcher unchanged', async () => {
    const fetcher: typeof fetch = () => Promise.resolve(Response.json({}))
    expect(sessionFetch(fetcher)).toBe(fetcher)
    const { fetcher: spied, calls } = spy(fetcher)
    await accountTransport(credential, AbortSignal.timeout(5000), {
      target: 'api',
      fetcher: spied,
      transactions: signer,
    })!.fetch('https://api.x.com/graphql/abc/Viewer')
    expect(calls).toEqual([
      { url: 'https://api.x.com/graphql/abc/Viewer', proxied: false },
    ])
  })

  test('a stopped proxy is no longer used', () => {
    const fetcher: typeof fetch = () => Promise.resolve(new Response(''))
    useSessionProxy(proxy.url)()
    expect(sessionFetch(fetcher)).toBe(fetcher)
  })
})
