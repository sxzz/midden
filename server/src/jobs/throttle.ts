import type { WriteSummary } from '#db/writes.ts'
import type { QueueThrottle } from './queue.ts'

/** How the web process has been doing lately (`#http/load.ts`). */
export interface WebLoadSignal {
  /**
   * Each of the last few seconds' event-loop delay p99, oldest first.
   * Absent from an older web process's status file.
   */
  lagSeconds?: number[]
  /** The worst of those, and the longest single stall. */
  lagP99Ms: number
  lagMaxMs: number
  /**
   * Requests slower than the slow-request threshold that ran on the web
   * process's own thread: everything else waited for them.
   */
  slowRequests: number
  /** Slow requests on a read thread: shown, never a reason to slow down. */
  threadSlowRequests?: number
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

/** What showed the pressure, for the admin page's words. */
export type PressureSignal = 'web_lag' | 'web_slow' | 'lock_wait' | 'write_duty'

export interface PressureReading {
  pressure: Pressure
  /** The worst signal, for logs; '' when calm. */
  reason: string
  signal?: PressureSignal
  /** Milliseconds, a count of requests, or a percentage, by `signal`. */
  value?: number
}

export interface ThrottleState {
  /** The share of each queue's configured concurrency in use, 1 at most. */
  factor: number
  pressure: Pressure
  /** The worst signal of the last step, for logs. */
  reason: string
  /**
   * Why concurrency is lowered: the reading that last halved it. Kept
   * until the factor is back to 1.
   */
  cause?: { signal: PressureSignal; value: number; reason: string }
}

// A second whose event-loop delay p99 reaches this is a stall: a busy
// timeout or a long synchronous request on the web process's own thread.
const STALL = 200
const SLOW_LAG = 100
// The worker waiting this long for the write lock means another process
// (the web process, a Litestream checkpoint) held it that long.
const LOCK_WAIT_HIGH = 500
const LOCK_WAIT_ELEVATED = 150
// The share of the time the worker holds the write lock: the web process's
// writes wait meanwhile, and above about half they keep missing it.
const DUTY_HIGH = 0.6
const DUTY_ELEVATED = 0.4
const MIN_FACTOR = 0.25
const STEP_UP = 0.25
/** High steps in a row before concurrency is halved. */
const SUSTAINED = 2
/**
 * Steps between two halvings: the web process reports its last 5 s, so
 * one burst stays in its readings that long and must not halve twice.
 */
const COOLDOWN = 5
/** Calm steps before concurrency grows again. */
const CALM_STEPS = 3
/** Calm steps before idle-only work may run. */
const IDLE_STEPS = 10

type Check = [Pressure, boolean, PressureSignal, number, string]

/**
 * One reading. From the web process (its last 5 s): two or more seconds
 * that stalled (p99 at least 200 ms), or two or more slow requests on its
 * own thread, are high; one of either, or two seconds at 100 ms, elevated.
 * One stall or one slow request is noise (a GC, one heavy read), so they
 * alone never slow the worker down. Slow requests on read threads do not
 * count. From the worker's own writes in the last step: a lock wait of
 * 500 ms or holding the lock 60% of the time is high, 150 ms or 40%
 * elevated.
 */
export function pressure(signals: ThrottleSignals): PressureReading {
  const { web, writes, elapsedMs } = signals
  const duty = elapsedMs > 0 ? writes.holdMs / elapsedMs : 0
  const seconds = web?.lagSeconds ?? (web ? [web.lagP99Ms] : [])
  const stalls = seconds.filter((ms) => ms >= STALL).length
  const slowSeconds = seconds.filter((ms) => ms >= SLOW_LAG).length
  const slow = web?.slowRequests ?? 0
  const lag = Math.max(0, ...seconds)
  const wait = Math.round(writes.maxWaitMs)
  const percent = Math.round(duty * 100)
  const checks: Check[] = [
    ['high', stalls >= 2, 'web_lag', lag, `web lag ${lag} ms in ${stalls} s`],
    ['high', slow >= 2, 'web_slow', slow, `${slow} slow web requests`],
    ['high', wait >= LOCK_WAIT_HIGH, 'lock_wait', wait, `lock wait ${wait} ms`],
    [
      'high',
      duty >= DUTY_HIGH,
      'write_duty',
      percent,
      `write duty ${percent}%`,
    ],
    ['elevated', stalls === 1, 'web_lag', lag, `web lag ${lag} ms in 1 s`],
    [
      'elevated',
      slowSeconds >= 2,
      'web_lag',
      lag,
      `web lag ${lag} ms in ${slowSeconds} s`,
    ],
    ['elevated', slow === 1, 'web_slow', slow, '1 slow web request'],
    [
      'elevated',
      wait >= LOCK_WAIT_ELEVATED,
      'lock_wait',
      wait,
      `lock wait ${wait} ms`,
    ],
    [
      'elevated',
      duty >= DUTY_ELEVATED,
      'write_duty',
      percent,
      `write duty ${percent}%`,
    ],
  ]
  for (const [level, hit, signal, value, reason] of checks)
    if (hit) return { pressure: level, reason, signal, value }
  return { pressure: 'calm', reason: '' }
}

/**
 * Adaptive concurrency for the worker, stepped once a second: halved when
 * the pressure stays high for two steps in a row (at most once in five
 * steps, never below a quarter), held while it is elevated, and after three
 * calm steps grown back by a quarter each step. Idle-only work (moving raw
 * responses out) runs only after ten calm steps at full concurrency.
 */
export class Throttle implements QueueThrottle {
  #factor = 1
  #pressure: Pressure = 'calm'
  #reason = ''
  #cause: ThrottleState['cause']
  #calmSteps = IDLE_STEPS
  #highSteps = 0
  #sinceCut = COOLDOWN

  step(signals: ThrottleSignals): ThrottleState {
    const reading = pressure(signals)
    this.#pressure = reading.pressure
    this.#reason = reading.reason
    this.#sinceCut++
    if (reading.pressure === 'high') {
      this.#highSteps++
      this.#calmSteps = 0
      if (
        this.#highSteps >= SUSTAINED &&
        this.#sinceCut >= COOLDOWN &&
        this.#factor > MIN_FACTOR
      ) {
        this.#factor = Math.max(MIN_FACTOR, this.#factor / 2)
        this.#cause = {
          signal: reading.signal!,
          value: reading.value!,
          reason: reading.reason,
        }
        this.#sinceCut = 0
      }
    } else {
      this.#highSteps = 0
      if (reading.pressure === 'elevated') this.#calmSteps = 0
      else if (++this.#calmSteps >= CALM_STEPS)
        this.#factor = Math.min(1, this.#factor + STEP_UP)
    }
    if (this.#factor === 1) this.#cause = undefined
    return this.state()
  }

  state(): ThrottleState {
    return {
      factor: this.#factor,
      pressure: this.#pressure,
      reason: this.#reason,
      ...(this.#cause ? { cause: this.#cause } : {}),
    }
  }

  limit(_queue: string, base: number): number {
    return Math.max(1, Math.round(base * this.#factor))
  }

  calm(): boolean {
    return this.#factor === 1 && this.#calmSteps >= IDLE_STEPS
  }
}
