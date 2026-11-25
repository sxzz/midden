/** One write transaction: how long it waited for the lock and held it. */
export interface WriteSample {
  waitMs: number
  holdMs: number
}

/** What the write transactions of a period added up to. */
export interface WriteSummary {
  count: number
  /** Time spent waiting for the write lock, summed and the longest. */
  waitMs: number
  maxWaitMs: number
  /** Time spent holding it, summed and the longest. */
  holdMs: number
  maxHoldMs: number
}

/**
 * The write transactions of one connection, summed until read. The worker's
 * throttle reads them each second: waiting on the lock means another
 * process (the web process, Litestream) holds it, and holding it much of
 * the time keeps the web process's writes waiting.
 */
export class WriteStats {
  #summary = WriteStats.#empty()
  /** Told of each transaction; the runtime logs the slow ones. */
  onWrite: ((sample: WriteSample) => void) | undefined

  static #empty(): WriteSummary {
    return { count: 0, waitMs: 0, maxWaitMs: 0, holdMs: 0, maxHoldMs: 0 }
  }

  record(waitMs: number, holdMs: number): void {
    const s = this.#summary
    s.count++
    s.waitMs += waitMs
    s.holdMs += holdMs
    if (waitMs > s.maxWaitMs) s.maxWaitMs = waitMs
    if (holdMs > s.maxHoldMs) s.maxHoldMs = holdMs
    this.onWrite?.({ waitMs, holdMs })
  }

  /** The summary since the last call, starting a new one. */
  take(): WriteSummary {
    const taken = this.#summary
    this.#summary = WriteStats.#empty()
    return taken
  }
}
