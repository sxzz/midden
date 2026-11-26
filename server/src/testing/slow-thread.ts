// A read thread for the pool's tests: `slow` keeps SQLite busy in one
// statement for `ms` milliseconds, as a heavy query would; `echo` answers at
// once; `fail` throws. Started by path, like `reads/thread.ts`.
import { DatabaseSync } from 'node:sqlite'
import { parentPort } from 'node:worker_threads'
import { errorBody } from '#agent/errors.ts'
import type { PoolRequest, PoolResponse } from '#reads/pool.ts'

if (parentPort) {
  const port = parentPort
  const db = new DatabaseSync(':memory:')
  // The deadline is checked every 10,000 rows; the rest is SQLite alone.
  db.function('now_ms', { deterministic: false }, () => Date.now())
  const slow = db.prepare(`WITH RECURSIVE c(x) AS (
      SELECT 1 UNION ALL SELECT x + 1 FROM c
      WHERE x % 10000 != 0 OR now_ms() < ?)
    SELECT count(*) AS n FROM c`)
  port.on('message', (request: PoolRequest) => {
    let response: PoolResponse
    try {
      const input = request.input as { ms?: number }
      if (request.op === 'slow')
        response = {
          id: request.id,
          ok: true,
          value: slow.get(Date.now() + (input.ms ?? 0)),
        }
      else if (request.op === 'echo')
        response = { id: request.id, ok: true, value: request.input }
      else throw new Error(`no read ${request.op}`)
    } catch (error) {
      response = {
        id: request.id,
        ok: false,
        error: errorBody(error),
        cause: String(error),
      }
    }
    port.postMessage(response)
  })
  port.postMessage({ ready: true } satisfies PoolResponse)
}
