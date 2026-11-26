import { AgentError } from './errors.ts'

/** Requests in flight across all tokens; the read pool has as many threads. */
export const IN_FLIGHT = 2
/** How long a request beyond them waits for a turn before `busy`. */
export const QUEUE_WAIT_MS = 3000
/** What `Retry-After` suggests to a request turned away. */
export const RETRY_AFTER_S = 2

/**
 * At most `limit` agent requests at once, whoever's token they carry; the
 * next ones wait in order for up to `waitMs`, then fail with `busy`. There
 * is no rate limit: usage is only counted.
 */
export class Gate {
  readonly limit: number
  readonly waitMs: number
  #running = 0
  #waiting: { admit: () => void; timer: ReturnType<typeof setTimeout> }[] = []

  constructor(options: { limit?: number; waitMs?: number } = {}) {
    this.limit = options.limit ?? IN_FLIGHT
    this.waitMs = options.waitMs ?? QUEUE_WAIT_MS
  }

  get running(): number {
    return this.#running
  }

  get waiting(): number {
    return this.#waiting.length
  }

  /** Wait for a turn; call the returned function when done. */
  async enter(): Promise<() => void> {
    if (this.#running < this.limit && !this.#waiting.length) {
      this.#running++
      return this.#leave()
    }
    await new Promise<void>((resolve, reject) => {
      const entry = {
        admit: resolve,
        timer: setTimeout(() => {
          this.#waiting.splice(this.#waiting.indexOf(entry), 1)
          reject(
            new AgentError(
              'busy',
              `${this.limit} requests are already running. Retry after a few seconds, one request at a time.`,
            ),
          )
        }, this.waitMs),
      }
      this.#waiting.push(entry)
    })
    return this.#leave()
  }

  #leave(): () => void {
    let left = false
    return () => {
      if (left) return
      left = true
      const next = this.#waiting.shift()
      if (next) {
        // The turn passes straight on: running stays the same.
        clearTimeout(next.timer)
        next.admit()
      } else this.#running--
    }
  }
}
