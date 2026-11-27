// Slow queries on the read threads: every statement a thread's connection
// runs is timed, and one that takes `SLOW_QUERY_MS` or longer is reported
// with what asked for it (the route, its query or filter), its SQL and
// parameters, how long it took and how many rows it gave. The web process
// logs it and keeps the last few hundred (`slow-log.ts`), so that indexes
// can be added from what production actually runs.
import { AsyncLocalStorage } from 'node:async_hooks'
import { performance } from 'node:perf_hooks'
import type { DatabaseSync } from 'node:sqlite'

/** A statement that runs this long is a slow query. */
export const SLOW_QUERY_MS = 300

export interface SlowQuery {
  /** When it ended, ms since the epoch. */
  at: number
  /** `GET /v1/collections`, `GET /agent/v1/posts`… */
  route: string
  /** The request's query or filter, as canonical as it is known. */
  query: string
  sql: string
  /** JSON of the bound parameters. */
  params: string
  ms: number
  rows: number
}

interface Scope {
  route: string
  query: string
}

const scope = new AsyncLocalStorage<Scope>()

/** Run a request's reads as `route` asking `query`. */
export function inScope<T>(route: string, query: string, fn: () => T): T {
  return scope.run({ route, query }, fn)
}

/** Name the request's query once it is known in its canonical form. */
export function describeQuery(query: string): void {
  const current = scope.getStore()
  if (current) current.query = query
}

/** Long SQL and parameters are cut, so a record stays a few KB. */
const MAX_TEXT = 4000

const cut = (text: string) =>
  text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text

function paramsJson(params: unknown[]): string {
  return cut(
    JSON.stringify(params, (_, value: unknown) =>
      typeof value === 'bigint'
        ? String(value)
        : value instanceof Uint8Array
          ? `<${value.byteLength} bytes>`
          : value,
    ),
  )
}

/**
 * Time every statement `client` prepares from now on; `onSlow` hears of the
 * ones at or over `threshold`. Wraps `prepare`, which Drizzle and the raw
 * client both call for each statement they run.
 */
export function watchStatements(
  client: DatabaseSync,
  onSlow: (query: SlowQuery) => void,
  threshold = SLOW_QUERY_MS,
): void {
  const prepare = client.prepare.bind(client)
  client.prepare = ((sql: string) => {
    const statement = prepare(sql)
    for (const method of ['all', 'get', 'run'] as const) {
      const run = statement[method].bind(statement) as (
        ...params: unknown[]
      ) => unknown
      Object.defineProperty(statement, method, {
        configurable: true,
        value: (...params: unknown[]) => {
          const started = performance.now()
          const result = run(...params)
          const ms = performance.now() - started
          if (ms >= threshold) {
            const current = scope.getStore()
            onSlow({
              at: Date.now(),
              route: current?.route ?? '',
              query: cut(current?.query ?? ''),
              sql: cut(sql),
              params: paramsJson(params),
              ms: Math.round(ms),
              rows:
                method === 'all'
                  ? (result as unknown[]).length
                  : method === 'get'
                    ? result
                      ? 1
                      : 0
                    : Number((result as { changes: number }).changes),
            })
          }
          return result
        },
      })
    }
    return statement
  }) as DatabaseSync['prepare']
}
