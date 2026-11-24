import { AsyncLocalStorage } from 'node:async_hooks'
import { performance } from 'node:perf_hooks'
import type { Logger } from '#log.ts'

/**
 * Evidence of upstream requests for the logs. Platform code sends its
 * requests through `upstream()`; whoever runs a platform call wraps it in
 * `traceUpstream()`, which logs the requests that failed once the call's
 * outcome and classification are known. Outside a trace nothing is recorded.
 */

export interface Exchange {
  provider: string
  operation: string
  method: string
  /** Without credentials, query tokens or fragment. */
  url: string
  status?: number
  headers?: Record<string, string>
  /** The first bytes of a textual body, secrets masked. */
  body?: string
  /** Why no response arrived (network error, timeout). */
  error?: string
  durationMs: number
}

interface Trace {
  exchanges: Exchange[]
}

/** How a failed platform call is treated, for the log entry. */
export interface Classification {
  code: string
  message: string
  retryable: boolean
  /** No further automatic attempt follows. */
  final: boolean
}

export interface TraceOptions {
  logger: Logger
  /** `undefined` when the error is not a failure (e.g. the job was snoozed). */
  classify: (error: unknown) => Classification | undefined
}

const traces = new AsyncLocalStorage<Trace>()
const EXCERPT_BYTES = 2048
const MAX_URL = 1024
// A profile timeline takes about 15 pages; keep the failures and the last.
const MAX_EXCHANGES = 32
const HEADERS = [
  'retry-after',
  'x-rate-limit-limit',
  'x-rate-limit-remaining',
  'x-rate-limit-reset',
  'content-type',
  'content-length',
  'cf-mitigated',
  'cf-ray',
  'location',
]
const SECRET_PARAM =
  /token|auth|csrf|secret|session|cookie|password|passwd|sig|key|^ct0$|^code$/i
// `name=value`, `"name":"value"` and `Bearer value` forms in a body.
const SECRET_TEXT =
  /((?:auth_token|ct0|csrf_?token|sessionid|access_token|refresh_token|authorization|cookie|password)["']?\s*[=:]\s*["']?(?:bearer\s+)?)[^"'&;,\s}]+|(bearer\s+)[\w%.~+/=-]+/gi

export function redactURL(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return '[invalid url]'
  }
  url.username = ''
  url.password = ''
  url.hash = ''
  for (const key of new Set(url.searchParams.keys()))
    if (SECRET_PARAM.test(key)) url.searchParams.set(key, 'redacted')
  const href = url.href
  return href.length > MAX_URL ? `${href.slice(0, MAX_URL)}…` : href
}

export function redactText(text: string): string {
  return text.replaceAll(
    SECRET_TEXT,
    (_, name: string | undefined, bearer: string | undefined) =>
      `${name ?? bearer}[redacted]`,
  )
}

/** Which service and endpoint a URL belongs to. */
export function describe(raw: string): { provider: string; operation: string } {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { provider: 'unknown', operation: 'unknown' }
  }
  const host = url.hostname
  const path = url.pathname
  if (host === 'api.fxtwitter.com')
    return {
      provider: 'fxtwitter',
      operation: path.endsWith('/statuses')
        ? 'profile-timeline'
        : path.startsWith('/2/profile/')
          ? 'profile'
          : path.startsWith('/2/status/')
            ? 'status'
            : path,
    }
  if (/(?:^|\.)(?:x|twitter)\.com$/.test(host)) {
    const graphql = path.match(/\/graphql\/[^/]+\/(\w+)/)
    if (graphql) return { provider: 'x-graphql', operation: graphql[1]! }
    return { provider: 'x-web', operation: path }
  }
  if (/(?:^|\.)instagram\.com$/.test(host))
    return { provider: 'instagram', operation: template(path) }
  return { provider: host, operation: template(path) }
}

// Numeric and media IDs vary per request; the shape names the endpoint.
const template = (path: string) =>
  path.replaceAll(/\/(?:\d+|[\w-]{20,})(?=\/|$)/g, '/:id')

const textual = (type: string | null) =>
  !type || /json|text|xml|javascript|html/i.test(type)

async function excerpt(response: Response): Promise<string | undefined> {
  if (!response.body || !textual(response.headers.get('content-type'))) return
  // Read a copy, so the platform code still gets the whole body.
  const reader = response.clone().body!.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (size < EXCERPT_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      size += value.length
    }
  } catch {
    // Keep what arrived before the body broke off.
  } finally {
    reader.cancel().catch(() => {})
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  const text = new TextDecoder().decode(bytes.subarray(0, EXCERPT_BYTES))
  return redactText(size > EXCERPT_BYTES ? `${text}…` : text)
}

function requestURL(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

/** Send a platform request, recording it when the call is traced. */
export async function upstream(
  fetcher: typeof fetch,
  input: string | URL | Request,
  init: RequestInit = {},
): Promise<Response> {
  const trace = traces.getStore()
  if (!trace) return fetcher(input, init)
  const url = requestURL(input)
  const started = performance.now()
  const exchange: Exchange = {
    ...describe(url),
    method: init.method ?? (input instanceof Request ? input.method : 'GET'),
    url: redactURL(url),
    durationMs: 0,
  }
  trace.exchanges.push(exchange)
  if (trace.exchanges.length > MAX_EXCHANGES) {
    const index = trace.exchanges.findIndex((e) => !failed(e))
    trace.exchanges.splice(index === -1 ? 0 : index, 1)
  }
  let response: Response
  try {
    response = await fetcher(input, init)
  } catch (error) {
    exchange.error =
      error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    exchange.durationMs = Math.round(performance.now() - started)
    throw error
  }
  exchange.durationMs = Math.round(performance.now() - started)
  exchange.status = response.status
  const headers: Record<string, string> = {}
  for (const name of HEADERS) {
    const value = response.headers.get(name)
    if (value !== null)
      headers[name] =
        name === 'location' && URL.canParse(value, url)
          ? redactURL(new URL(value, url).href)
          : value
  }
  exchange.headers = headers
  exchange.body = await excerpt(response)
  return response
}

const failed = (e: Exchange) =>
  e.error !== undefined || e.status === undefined || e.status >= 300

/**
 * Run a platform call and log each upstream request that failed: warn when
 * another attempt follows, error when none does, info when the call still
 * succeeded. A failed call also logs its last request, as some APIs put the
 * error in a successful response's body.
 */
export async function traceUpstream<T>(
  options: TraceOptions,
  run: () => Promise<T>,
): Promise<T> {
  const trace: Trace = { exchanges: [] }
  try {
    const result = await traces.run(trace, run)
    for (const exchange of trace.exchanges.filter(failed))
      options.logger.info(
        { upstream: exchange },
        'upstream request failed; the call recovered',
      )
    return result
  } catch (error) {
    const classification = options.classify(error)
    if (classification) {
      const last = trace.exchanges.at(-1)
      const logged = trace.exchanges.filter((e) => failed(e) || e === last)
      const fields = {
        errorCode: classification.code,
        errorMessage: classification.message,
        retryable: classification.retryable,
        final: classification.final,
      }
      const level = classification.final ? 'error' : 'warn'
      if (!logged.length)
        options.logger[level](fields, 'platform call failed before any request')
      for (const exchange of logged)
        options.logger[level](
          { ...fields, upstream: exchange },
          'upstream request failed',
        )
    }
    throw error
  }
}
