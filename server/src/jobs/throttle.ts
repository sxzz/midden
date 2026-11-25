import type { WriteSummary } from '#db/writes.ts'
import type { QueueThrottle } from './queue.ts'

/** How the web process has been doing lately (`#http/load.ts`). */
export interface WebLoadSignal {
  /** Event-loop delay over the last few seconds. */
  lagP99Ms: number
  lagMaxMs: number
  /** Requests slower than the slow-request threshold in that time. */
  slowRequests: number
}

export interface ThrottleSignals {
  /** Missing when the web process has not reported recently. */
  web?: WebLoadSignal
  /** The worker's own write transactions since the last step. */
  writes: WriteSummary
  /** Wall time since the last step, for the share of it spent writing. */
  elapsedMs: number
}

export type Pressure = 'calm' | 'elevated' | 'high'

export interface ThrottleState {
  /** The share of each queue's configured concurrency in use, 1 at most. */
  factor: number
  pressure: Pressure
  /** The worst signal of the last step, for logs and the admin page. */
  reason: string
}

// The web process is slow when its event loop stalls this long; a busy
// timeout or a long synchronous request shows up here.
const WEB_LAG_HIGH = 200
const WEB_LAG_ELEVATED = 100
// The worker waiting this long for the write lock means another process
// (the web process, a Litestream checkpoint) held it that long.
const LOCK_WAIT_HIGH = 500
const LOCK_WAIT_ELEVATED = 150
// The share of the time the worker holds the write lock: the web process's
// writes wait meanwhile, and above about half they keep missing it.
const DUTY_HIGH = 0.6
const DUTY_ELEVATED = 0.4
const MIN_FACTOR = 0.25
const STEP_UP = 0.125
/** Calm steps before concurrency grows again. */
const CALM_STEPS = 3
/** Calm steps before idle-only work may run. */
const IDLE_STEPS = 10

export function pressure(signals: ThrottleSignals): {
  pressure: Pressure
  reason: string
} {
  const { web, writes, elapsedMs } = signals
  const duty = elapsedMs > 0 ? writes.holdMs / elapsedMs : 0
  const checks: [Pressure, boolean, string][] = [
    [
      'high',
      !!web && web.lagMaxMs >= WEB_LAG_HIGH,
      `web lag ${web?.lagMaxMs} ms`,
    ],
    [
      'high',
      !!web && web.slowRequests > 0,
      `${web?.slowRequests} slow web requests`,
    ],
    [
      'high',
      writes.maxWaitMs >= LOCK_WAIT_HIGH,
      `lock wait ${Math.round(writes.maxWaitMs)} ms`,
    ],
    ['high', duty >= DUTY_HIGH, `write duty ${Math.round(duty * 100)}%`],
    [
      'elevated',
      !!web && web.lagP99Ms >= WEB_LAG_ELEVATED,
      `web lag p99 ${web?.lagP99Ms} ms`,
    ],
    [
      'elevated',
      writes.maxWaitMs >= LOCK_WAIT_ELEVATED,
      `lock wait ${Math.round(writes.maxWaitMs)} ms`,
    ],
    [
      'elevated',
      duty >= DUTY_ELEVATED,
      `write duty ${Math.round(duty * 100)}%`,
    ],
  ]
  for (const [level, hit, reason] of checks)
    if (hit) return { pressure: level, reason }
  return { pressure: 'calm', reason: '' }
}

/**
 * Adaptive concurrency for the worker: halve it when the web process stalls
 * or the write lock is contended, grow it back slowly once things are calm,
 * and let idle-only work (moving raw responses out) run only after a calm
 * spell at full concurrency. Stepped once a second.
 */
export class Throttle implements QueueThrottle {
  #factor = 1
  #pressure: Pressure = 'calm'
  #reason = ''
  #calmSteps = IDLE_STEPS

  step(signals: ThrottleSignals): ThrottleState {
    const { pressure: level, reason } = pressure(signals)
    this.#pressure = level
    this.#reason = reason
    if (level === 'high') {
      this.#factor = Math.max(MIN_FACTOR, this.#factor / 2)
      this.#calmSteps = 0
    } else if (level === 'elevated') {
      this.#calmSteps = 0
    } else if (++this.#calmSteps >= CALM_STEPS) {
      this.#factor = Math.min(1, this.#factor + STEP_UP)
    }
    return this.state()
  }

  state(): ThrottleState {
    return {
      factor: this.#factor,
      pressure: this.#pressure,
      reason: this.#reason,
    }
  }

  limit(_queue: string, base: number): number {
    return Math.max(1, Math.round(base * this.#factor))
  }

  calm(): boolean {
    return this.#factor === 1 && this.#calmSteps >= IDLE_STEPS
  }
}
