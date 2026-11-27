import { describe, expect, test } from 'vitest'
import {
  pressure,
  Throttle,
  type ThrottleSignals,
  type WebLoadSignal,
} from './throttle.ts'

const quietWeb: WebLoadSignal = {
  lagSeconds: [15, 22, 18, 27, 16],
  lagP99Ms: 27,
  lagMaxMs: 40,
  slowRequests: 0,
  threadSlowRequests: 0,
}
const quiet: ThrottleSignals = {
  web: quietWeb,
  writes: { count: 40, waitMs: 5, maxWaitMs: 1, holdMs: 100, maxHoldMs: 8 },
  elapsedMs: 1000,
}
const web = (over: Partial<WebLoadSignal>): ThrottleSignals => ({
  ...quiet,
  web: { ...quietWeb, ...over },
})
const writes = (over: Partial<ThrottleSignals['writes']>): ThrottleSignals => ({
  ...quiet,
  writes: { ...quiet.writes, ...over },
})

describe('pressure', () => {
  test('slow requests on read threads never count', () => {
    // As in production: reads on the threads take seconds, the event loop
    // is fine, one stall of 206 ms.
    expect(
      pressure(web({ threadSlowRequests: 6, lagMaxMs: 206 })).pressure,
    ).toBe('calm')
  })

  test('the web process: two stalled seconds or two slow inline requests are high', () => {
    expect(pressure(web({ lagSeconds: [20, 250, 30, 310, 20] }))).toEqual({
      pressure: 'high',
      reason: 'web lag 310 ms in 2 s',
      signal: 'web_lag',
      value: 310,
    })
    expect(
      pressure(web({ lagSeconds: [20, 250, 30], lagP99Ms: 250 })),
    ).toMatchObject({ pressure: 'elevated', signal: 'web_lag', value: 250 })
    expect(
      pressure(web({ lagSeconds: [120, 30, 140], lagP99Ms: 140 })).pressure,
    ).toBe('elevated')
    expect(pressure(web({ slowRequests: 2 }))).toMatchObject({
      pressure: 'high',
      signal: 'web_slow',
      value: 2,
    })
    expect(pressure(web({ slowRequests: 1 })).pressure).toBe('elevated')
    // An older web process's report, without the seconds.
    expect(
      pressure(web({ lagSeconds: undefined, lagP99Ms: 300 })).pressure,
    ).toBe('elevated')
  })

  test("the worker's own writes: lock waits and holding the lock", () => {
    expect(pressure(writes({ maxWaitMs: 800 }))).toMatchObject({
      pressure: 'high',
      signal: 'lock_wait',
      value: 800,
      reason: 'lock wait 800 ms',
    })
    expect(pressure(writes({ holdMs: 700 }))).toMatchObject({
      pressure: 'high',
      signal: 'write_duty',
      value: 70,
    })
    expect(pressure(writes({ holdMs: 450 })).pressure).toBe('elevated')
    expect(pressure(writes({ maxWaitMs: 200 })).pressure).toBe('elevated')
    // Without a report from the web process, only the lock counts.
    expect(pressure({ ...quiet, web: undefined }).pressure).toBe('calm')
  })
})

describe('throttle', () => {
  test('production: slow threaded reads all the time leave it at full speed', () => {
    const throttle = new Throttle()
    for (let i = 0; i < 60; i++)
      throttle.step(web({ threadSlowRequests: 1 + (i % 3), lagMaxMs: 206 }))
    expect(throttle.state()).toEqual({
      factor: 1,
      pressure: 'calm',
      reason: '',
    })
    expect(throttle.calm()).toBe(true)
  })

  test('one high step is not enough; sustained pressure halves, once per burst', () => {
    const throttle = new Throttle()
    const lagging = web({ lagSeconds: [250, 300, 20], lagP99Ms: 300 })
    throttle.step(lagging)
    expect(throttle.state().factor).toBe(1)
    throttle.step(lagging)
    expect(throttle.state()).toMatchObject({
      factor: 0.5,
      pressure: 'high',
      cause: { signal: 'web_lag', value: 300 },
    })
    // The same seconds stay in the web's readings for a while: no second
    // halving until the cooldown is over.
    for (let i = 0; i < 4; i++) throttle.step(lagging)
    expect(throttle.state().factor).toBe(0.5)
    throttle.step(lagging)
    expect(throttle.state().factor).toBe(0.25)
    // Never below a quarter, and never below one job.
    for (let i = 0; i < 10; i++) throttle.step(lagging)
    expect(throttle.state().factor).toBe(0.25)
    expect(throttle.limit('capture', 4)).toBe(1)
    expect(throttle.limit('raw', 1)).toBe(1)
  })

  test('inline slow requests and lock waits slow it down too', () => {
    const slow = new Throttle()
    slow.step(web({ slowRequests: 2 }))
    slow.step(web({ slowRequests: 3 }))
    expect(slow.state()).toMatchObject({
      factor: 0.5,
      cause: { signal: 'web_slow', value: 3 },
    })
    const locked = new Throttle()
    locked.step(writes({ maxWaitMs: 900 }))
    locked.step(writes({ maxWaitMs: 700 }))
    expect(locked.state()).toMatchObject({
      factor: 0.5,
      cause: { signal: 'lock_wait', value: 700 },
    })
  })

  test('a high step between quiet ones does not count as sustained', () => {
    const throttle = new Throttle()
    for (let i = 0; i < 10; i++) {
      throttle.step(writes({ maxWaitMs: 900 }))
      throttle.step(quiet)
    }
    expect(throttle.state().factor).toBe(1)
  })

  test('elevated holds; calm grows it back a quarter a step after three', () => {
    const throttle = new Throttle()
    const high = writes({ holdMs: 900 })
    for (let i = 0; i < 7; i++) throttle.step(high)
    expect(throttle.state().factor).toBe(0.25)
    for (let i = 0; i < 5; i++) throttle.step(web({ slowRequests: 1 }))
    expect(throttle.state()).toMatchObject({
      factor: 0.25,
      pressure: 'elevated',
      cause: { signal: 'write_duty', value: 90 },
    })
    throttle.step(quiet)
    throttle.step(quiet)
    expect(throttle.state().factor).toBe(0.25)
    throttle.step(quiet)
    expect(throttle.state().factor).toBe(0.5)
    throttle.step(quiet)
    throttle.step(quiet)
    expect(throttle.state().factor).toBe(1)
    // Back to full: no cause any more.
    expect(throttle.state().cause).toBeUndefined()
    // Idle-only work waits for a longer calm spell.
    expect(throttle.calm()).toBe(false)
    for (let i = 0; i < 5; i++) throttle.step(quiet)
    expect(throttle.calm()).toBe(true)
  })
})
