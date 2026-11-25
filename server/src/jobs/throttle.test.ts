import { describe, expect, test } from 'vitest'
import { pressure, Throttle, type ThrottleSignals } from './throttle.ts'

const quiet: ThrottleSignals = {
  web: { lagP99Ms: 12, lagMaxMs: 20, slowRequests: 0 },
  writes: { count: 40, waitMs: 5, maxWaitMs: 1, holdMs: 100, maxHoldMs: 8 },
  elapsedMs: 1000,
}

describe('throttle', () => {
  test('reads pressure from the web process and the write lock', () => {
    expect(pressure(quiet)).toEqual({ pressure: 'calm', reason: '' })
    expect(
      pressure({ ...quiet, web: { ...quiet.web!, lagMaxMs: 900 } }),
    ).toEqual({ pressure: 'high', reason: 'web lag 900 ms' })
    expect(
      pressure({ ...quiet, web: { ...quiet.web!, slowRequests: 2 } }).pressure,
    ).toBe('high')
    expect(
      pressure({ ...quiet, writes: { ...quiet.writes, maxWaitMs: 800 } }),
    ).toEqual({ pressure: 'high', reason: 'lock wait 800 ms' })
    expect(
      pressure({ ...quiet, writes: { ...quiet.writes, holdMs: 700 } }),
    ).toEqual({ pressure: 'high', reason: 'write duty 70%' })
    expect(
      pressure({ ...quiet, writes: { ...quiet.writes, holdMs: 450 } }).pressure,
    ).toBe('elevated')
    // Without a report from the web process, only the lock counts.
    expect(pressure({ ...quiet, web: undefined }).pressure).toBe('calm')
  })

  test('halves concurrency under pressure and grows it back slowly', () => {
    const throttle = new Throttle()
    expect(throttle.limit('capture', 4)).toBe(4)
    expect(throttle.calm()).toBe(true)

    const slow = { ...quiet, web: { ...quiet.web!, lagMaxMs: 500 } }
    throttle.step(slow)
    expect(throttle.limit('capture', 4)).toBe(2)
    expect(throttle.calm()).toBe(false)
    throttle.step(slow)
    throttle.step(slow)
    // Never below a quarter, and never below one job.
    expect(throttle.state().factor).toBe(0.25)
    expect(throttle.limit('capture', 4)).toBe(1)
    expect(throttle.limit('raw', 1)).toBe(1)

    // Calm for a while: an eighth back each step after the first few.
    for (let i = 0; i < 3; i++) throttle.step(quiet)
    expect(throttle.state().factor).toBe(0.375)
    for (let i = 0; i < 5; i++) throttle.step(quiet)
    expect(throttle.state().factor).toBe(1)
    // Idle-only work waits for a longer calm spell.
    expect(throttle.calm()).toBe(false)
    for (let i = 0; i < 2; i++) throttle.step(quiet)
    expect(throttle.calm()).toBe(true)
  })
})
