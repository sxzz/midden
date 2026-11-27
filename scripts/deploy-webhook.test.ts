import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { sendTelegram, type TelegramDeps } from './deploy-webhook.ts'

const TOKEN = '123456:SECRET-token'
const CHAT = '987654321'
const MESSAGE = { text: 'hello', entities: [] }

const json = (status: number, body: unknown) => Response.json(body, { status })

/** A fake fetch answering from a script; an Error entry is thrown. */
function setup(script: (Response | Error)[], timeout?: number) {
  const calls: { url: string; signal?: AbortSignal | null }[] = []
  const sleeps: number[] = []
  const logs: string[] = []
  const deps: TelegramDeps = {
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push({ url, signal: init?.signal })
      const next = script[calls.length - 1]
      if (!next) throw new Error('script exhausted')
      if (next instanceof Error) throw next
      return next
    }) as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    log: (line) => logs.push(line),
    timeout,
  }
  return { deps, calls, sleeps, logs }
}

function fetchFailed(code: string, message: string) {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error(message), { code }),
  })
}

describe('sendTelegram', () => {
  test('succeeds on the first attempt without waiting', async () => {
    const { deps, calls, sleeps } = setup([json(200, { ok: true })])
    const result = await sendTelegram(TOKEN, CHAT, MESSAGE, deps)
    assert.deepEqual(result, { ok: true, attempts: 1 })
    assert.equal(calls.length, 1)
    assert.deepEqual(sleeps, [])
  })

  test('retries network errors after 2, 5 and 15 seconds, then gives up', async () => {
    const error = fetchFailed('ETIMEDOUT', 'connect ETIMEDOUT 2001:db8::1:443')
    const { deps, calls, sleeps } = setup([error, error, error, error])
    const result = await sendTelegram(TOKEN, CHAT, MESSAGE, deps)
    assert.equal(result.ok, false)
    assert.equal(result.attempts, 4)
    assert.equal(calls.length, 4)
    assert.deepEqual(sleeps, [2000, 5000, 15_000])
  })

  test('a later success ends the retries', async () => {
    const { deps, sleeps } = setup([
      fetchFailed('ECONNRESET', 'read ECONNRESET'),
      json(502, { description: 'Bad Gateway' }),
      json(200, { ok: true }),
    ])
    const result = await sendTelegram(TOKEN, CHAT, MESSAGE, deps)
    assert.deepEqual(result, { ok: true, attempts: 3 })
    assert.deepEqual(sleeps, [2000, 5000])
  })

  test('429 waits for retry_after', async () => {
    const { deps, sleeps } = setup([
      json(429, {
        description: 'Too Many Requests: retry after 7',
        parameters: { retry_after: 7 },
      }),
      json(200, { ok: true }),
    ])
    const result = await sendTelegram(TOKEN, CHAT, MESSAGE, deps)
    assert.equal(result.ok, true)
    assert.deepEqual(sleeps, [7000])
  })

  test('a 4xx other than 429 is not retried', async () => {
    const { deps, calls, sleeps, logs } = setup([
      json(400, { ok: false, description: 'Bad Request: chat not found' }),
    ])
    const result = await sendTelegram(TOKEN, CHAT, MESSAGE, deps)
    assert.equal(result.ok, false)
    assert.equal(result.attempts, 1)
    assert.equal(calls.length, 1)
    assert.deepEqual(sleeps, [])
    assert.match(result.error!, /HTTP 400 description=Bad Request: chat not/)
    assert.equal(logs.length, 1)
  })

  test('a hung attempt is aborted by its timeout and retried', async () => {
    const { deps, sleeps } = setup([], 20)
    const signals: (AbortSignal | null | undefined)[] = []
    deps.fetch = ((_url: string, init: RequestInit) => {
      signals.push(init.signal)
      if (signals.length > 1) return Promise.resolve(json(200, { ok: true }))
      // The first attempt never answers; only its signal ends it.
      return new Promise((_, reject) => {
        init.signal!.addEventListener('abort', () =>
          reject(init.signal!.reason),
        )
      })
    }) as typeof fetch
    const result = await sendTelegram(TOKEN, CHAT, MESSAGE, deps)
    assert.deepEqual(result, { ok: true, attempts: 2 })
    assert.ok(signals.every(Boolean))
    assert.equal(signals[0]!.aborted, true)
    assert.deepEqual(sleeps, [2000])
  })

  test('logs the cause, the status and the description, but no secrets', async () => {
    const { deps, logs } = setup([
      fetchFailed(
        'ENETUNREACH',
        `connect ENETUNREACH https://api.telegram.org/bot${TOKEN}/sendMessage chat ${CHAT}`,
      ),
      json(500, { description: `Internal error for ${CHAT}` }),
      json(401, { description: 'Unauthorized' }),
    ])
    const result = await sendTelegram(TOKEN, CHAT, MESSAGE, deps)
    const all = [...logs, result.error].join('\n')
    assert.match(logs[0]!, /^attempt 1\/4 failed: TypeError: fetch failed /)
    assert.match(logs[0]!, /cause\.code=ENETUNREACH/)
    assert.match(logs[0]!, /cause\.message=connect ENETUNREACH/)
    assert.match(logs[1]!, /HTTP 500 description=Internal error/)
    assert.match(logs[2]!, /HTTP 401 description=Unauthorized/)
    assert.ok(!all.includes(TOKEN))
    assert.ok(!all.includes(CHAT))
  })
})
