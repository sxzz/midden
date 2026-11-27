import { createServer, type Server } from 'node:http'
import type { WebLoadSignal } from '#jobs/throttle.ts'
import type { Logger } from '#log.ts'
import type { WorkerReport } from './report.ts'

// How the web process and the worker learn how the other is doing: each
// answers a few plain HTTP requests on a port of its own that compose does
// not publish (the web process's is also where Litestream's heartbeats
// arrive). Asked for, not stored: a status row updated every second would
// write the database (and make Litestream upload a file every 10 s) even
// when nothing else happens, and wait for the write lock in the web process.

/** Where the web process answers `GET /internal/load`. */
export const LOAD_PATH = '/internal/load'
/** Where the worker answers `GET /status` (and its health check). */
export const STATUS_PATH = '/status'

/** A handler's answer: a JSON or text body, or a status without one. */
export type InternalAnswer =
  { json: unknown } | { text: string } | { status: number }

/**
 * A small HTTP server for the other process (and Litestream): `routes` by
 * exact `GET` path; anything else is 404.
 */
export function internalServer(options: {
  host: string
  port: number
  logger: Logger
  /** For logs. */
  name: string
  routes: Record<string, () => InternalAnswer>
}): Server {
  const server = createServer((req, res) => {
    const route =
      req.method === 'GET' ? options.routes[req.url ?? ''] : undefined
    if (!route) {
      res.writeHead(404).end()
      return
    }
    try {
      const answer = route()
      if ('json' in answer)
        res
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify(answer.json))
      else if ('text' in answer)
        res.writeHead(200, { 'Content-Type': 'text/plain' }).end(answer.text)
      else res.writeHead(answer.status).end()
    } catch (error) {
      options.logger.warn(
        { err: error, path: req.url },
        `${options.name} failed`,
      )
      res.writeHead(500).end()
    }
  })
  server.on('error', (error) =>
    options.logger.error({ err: error }, `${options.name} listener failed`),
  )
  server.listen(options.port, options.host, () =>
    options.logger.info({ port: options.port }, `${options.name} listening`),
  )
  return server
}

/** A JSON answer, or undefined when the other process did not give one. */
async function getJson<T>(
  url: string,
  timeoutMs: number,
): Promise<{ ok: true; value: T } | { ok: false; timedOut: boolean }> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return { ok: false, timedOut: false }
    return { ok: true, value: (await response.json()) as T }
  } catch (error) {
    return {
      ok: false,
      timedOut: error instanceof DOMException && error.name === 'TimeoutError',
    }
  }
}

const REPORT_TIMEOUT = 1000

/** The worker's report, asked for when the admin page wants it. */
export async function fetchWorkerReport(
  workerUrl: string,
): Promise<WorkerReport | undefined> {
  const answer = await getJson<WorkerReport>(
    `${workerUrl}${STATUS_PATH}`,
    REPORT_TIMEOUT,
  )
  return answer.ok ? answer.value : undefined
}

const PROBE_EVERY = 1000
const PROBE_TIMEOUT = 1000
/** A reading older than this is no reading (the web process is gone). */
const PROBE_FRESH = 5000

/**
 * The worker's view of the web process: its load, asked for every second.
 * The web process answering this takes a turn of its event loop, so no
 * answer within a second means it stalled at least that long: the probe
 * then reads as two stalled seconds, which the throttle counts as high
 * (`jobs/throttle.ts`), and two such probes in a row slow the worker down.
 * A refused connection (the web process restarting) is no reading at all.
 */
export class WebProbe {
  readonly #url: string
  readonly #now: () => number
  #signal: WebLoadSignal | undefined
  #at = -Infinity
  #timer: NodeJS.Timeout | undefined
  #probing = false

  constructor(webUrl: string, now: () => number = Date.now) {
    this.#url = `${webUrl}${LOAD_PATH}`
    this.#now = now
  }

  start(): void {
    this.#timer = setInterval(() => this.probe().catch(() => {}), PROBE_EVERY)
    this.#timer.unref()
    this.probe().catch(() => {})
  }

  stop(): void {
    clearInterval(this.#timer)
  }

  /** Ask once; the next `signal()` has the answer. */
  async probe(timeoutMs = PROBE_TIMEOUT): Promise<void> {
    if (this.#probing) return
    this.#probing = true
    try {
      const answer = await getJson<WebLoadSignal>(this.#url, timeoutMs)
      if (answer.ok) this.#record(answer.value)
      else if (answer.timedOut) {
        const stalled = Math.max(timeoutMs, 1)
        this.#record({
          lagSeconds: [stalled, stalled],
          lagP99Ms: stalled,
          lagMaxMs: stalled,
          slowRequests: 0,
          threadSlowRequests: 0,
        })
      } else this.#signal = undefined
    } finally {
      this.#probing = false
    }
  }

  #record(signal: WebLoadSignal): void {
    this.#signal = signal
    this.#at = this.#now()
  }

  /** The latest reading, if recent. */
  signal(): WebLoadSignal | undefined {
    return this.#now() - this.#at <= PROBE_FRESH ? this.#signal : undefined
  }
}
