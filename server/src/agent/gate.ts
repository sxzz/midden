import { AgentError } from './errors.ts'

/**
 * Requests in flight across all the admin's tokens; the read pool lets the
 * agent lane hold as many threads (`LANES.agent.max`).
 */
export const IN_FLIGHT = 2
/** Viewers' requests in flight, all viewers together; and each viewer's own. */
export const VIEWERS_IN_FLIGHT = 2
export const VIEWER_IN_FLIGHT = 1
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

  /** Wait for a turn, `waitMs` at most; call the returned function when done. */
  async enter(waitMs = this.waitMs): Promise<() => void> {
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
              `${this.limit} request${this.limit === 1 ? ' is' : 's are'} already running. Retry after a few seconds, one request at a time.`,
            ),
          )
        }, waitMs),
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

/**
 * Viewers' requests: each viewer's one at a time (their own gate), and all
 * of theirs together at most `shared.limit`, apart from the admin's gate so
 * a viewer's script never takes the admin's turns. A request waits for both
 * within one `waitMs`.
 */
export class ViewerGates {
  readonly shared: Gate
  readonly perUser: number
  readonly waitMs: number
  readonly #own = new Map<string, Gate>()

  constructor(
    options: { limit?: number; perUser?: number; waitMs?: number } = {},
  ) {
    this.waitMs = options.waitMs ?? QUEUE_WAIT_MS
    this.perUser = options.perUser ?? VIEWER_IN_FLIGHT
    this.shared = new Gate({
      limit: options.limit ?? VIEWERS_IN_FLIGHT,
      waitMs: this.waitMs,
    })
  }

  async enter(user: string): Promise<() => void> {
    const started = Date.now()
    let own = this.#own.get(user)
    if (!own) {
      own = new Gate({ limit: this.perUser, waitMs: this.waitMs })
      this.#own.set(user, own)
    }
    const gate = own
    const done = () => {
      // An idle viewer's gate is not kept.
      if (!gate.running && !gate.waiting && this.#own.get(user) === gate)
        this.#own.delete(user)
    }
    let leaveOwn: () => void
    try {
      leaveOwn = await gate.enter()
    } catch (error) {
      done()
      throw error
    }
    try {
      const leaveShared = await this.shared.enter(
        Math.max(0, this.waitMs - (Date.now() - started)),
      )
      return () => {
        leaveShared()
        leaveOwn()
        done()
      }
    } catch (error) {
      leaveOwn()
      done()
      throw error
    }
  }
}
